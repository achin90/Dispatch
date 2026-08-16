import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { GitHub } from "@/github"
import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  GitHubPrCreatePayload,
  GitHubPrMergePayload,
  GitHubPrQuery,
  GitReposQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout))
  })
}

async function scanGitRepos(root: string | undefined, query: string | undefined) {
  const rootDir = root || os.homedir()
  const repos: string[] = []
  const needle = query?.toLowerCase()

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    if (entries.some((e) => e.name === ".git")) {
      if (!needle || path.basename(dir).toLowerCase().includes(needle)) {
        repos.push(dir)
      }
      return
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.isSymbolicLink() && e.name !== "node_modules")
        .map((e) => walk(path.join(dir, e.name))),
    )
  }

  await walk(rootDir)
  repos.sort()
  return repos
}

async function detectWorktree(directory: string) {
  const dir = directory.replace(/\/+$/, "")
  const content = await fs.readFile(path.join(dir, ".git"), "utf-8").catch(() => null)
  if (!content?.startsWith("gitdir:")) return null
  const gitdir = content.replace("gitdir:", "").trim()
  const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir)
  const head = await fs.readFile(path.join(resolved, "HEAD"), "utf-8").catch(() => "")
  const branch = head.startsWith("ref:")
    ? head
        .replace("ref:", "")
        .trim()
        .replace(/^refs\/heads\//, "")
    : path.basename(dir)
  // Derive source repo: gitdir is like /path/to/main/.git/worktrees/name
  const match = resolved.match(/^(.+)\/\.git\/worktrees\//)
  return {
    name: path.basename(dir),
    branch,
    directory: dir,
    sourceRepo: match ? match[1] : path.dirname(resolved),
  }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    const gitRepos = Effect.fn("ExperimentalHttpApi.gitRepos")(function* (ctx: {
      query: typeof GitReposQuery.Type
    }) {
      return yield* Effect.promise(() => scanGitRepos(ctx.query.root, ctx.query.query))
    })

    const githubStatus = Effect.fn("ExperimentalHttpApi.githubStatus")(function* () {
      return yield* Effect.promise(() => GitHub.status())
    })

    const githubPr = Effect.fn("ExperimentalHttpApi.githubPr")(function* (ctx: { query: typeof GitHubPrQuery.Type }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => GitHub.pr(ctx.query.branch, ctx.query.cwd ?? instance.worktree))
    })

    const githubPrCreate = Effect.fn("ExperimentalHttpApi.githubPrCreate")(function* (ctx: {
      payload: typeof GitHubPrCreatePayload.Type
    }) {
      return yield* Effect.promise(() => GitHub.create(ctx.payload, ctx.payload.cwd))
    })

    const githubPrMerge = Effect.fn("ExperimentalHttpApi.githubPrMerge")(function* (ctx: {
      payload: typeof GitHubPrMergePayload.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => GitHub.merge(ctx.payload.number, ctx.payload.cwd ?? instance.worktree))
    })

    const worktreeInfo = Effect.fn("ExperimentalHttpApi.worktreeInfo")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => detectWorktree(instance.directory))
    })

    const worktreeDiff = Effect.fn("ExperimentalHttpApi.worktreeDiff")(function* () {
      const instance = yield* InstanceState.context
      return { diff: yield* Effect.promise(() => gitOutput(["diff", "HEAD"], instance.directory)) }
    })

    const worktreeDiffstat = Effect.fn("ExperimentalHttpApi.worktreeDiffstat")(function* () {
      const instance = yield* InstanceState.context
      const raw = yield* Effect.promise(() => gitOutput(["diff", "HEAD", "--numstat"], instance.directory))
      const lines = raw
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((p): p is [string, string, string] => p.length >= 3)
        .filter((p) => !isNaN(parseInt(p[0], 10)) && !isNaN(parseInt(p[1], 10)))
      return {
        additions: lines.reduce((sum, p) => sum + parseInt(p[0], 10), 0),
        deletions: lines.reduce((sum, p) => sum + parseInt(p[1], 10), 0),
        files: new Set(lines.map((p) => p[2])).size,
      }
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("gitRepos", gitRepos)
      .handle("githubStatus", githubStatus)
      .handle("githubPr", githubPr)
      .handle("githubPrCreate", githubPrCreate)
      .handle("githubPrMerge", githubPrMerge)
      .handle("worktreeInfo", worktreeInfo)
      .handle("worktreeDiff", worktreeDiff)
      .handle("worktreeDiffstat", worktreeDiffstat)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
  }),
)
