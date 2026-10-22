import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { WorktreeDefinition } from "@opencode/plugin/effect/worktree"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit } from "effect"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DispatchAgentsPlugin } from "../src/plugin/agents"
import { DispatchCommandsPlugin } from "../src/plugin/commands"
import { DispatchWorktreePlugin } from "../src/plugin/worktree"
import { DispatchProcess } from "../src/process"

// Plugins only see the context domains they use; each test hands them the real core service for
// that domain and nothing else.
const context = (domains: Record<string, unknown>) => domains as unknown as Context

const run = <A, E>(effect: Effect.Effect<A, E, Agent.Service | Command.Service | import("effect").Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(LayerNode.compile(LayerNode.group([Agent.node, Command.node, Bus.node]))),
    ) as Effect.Effect<A, E>,
  )

describe("agents", () => {
  const agents = () =>
    run(
      Effect.gen(function* () {
        const service = yield* Agent.Service
        const ctx = context({ agent: { transform: service.transform } })
        yield* AgentPlugin.Plugin.effect(ctx)
        // Stands in for opencode.plan, which registers its agent the same way before Dispatch runs.
        yield* service.transform((editor) => editor.update(DispatchAgentsPlugin.plan, (item) => (item.mode = "primary")))
        yield* DispatchAgentsPlugin.Plugin.effect(ctx)
        return yield* service.list()
      }),
    )

  test("the switcher lists build and yolo, with no plan or assistant", async () => {
    const list = await agents()
    expect(list.filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => agent.id)).toEqual([
      Agent.ID.make("build"),
      DispatchAgentsPlugin.yolo,
    ])
    expect(list.some((agent) => agent.id === DispatchAgentsPlugin.plan)).toBe(false)
    // Subagents and the hidden helpers stay.
    expect(list.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(["general", "explore", "title", "summary", "compaction"].map((id) => Agent.ID.make(id))),
    )
  })

  test("build asks before shell and edits; yolo (and the hidden assistant) allow everything", async () => {
    const list = await agents()
    const rules = (id: string) => list.find((agent) => agent.id === id)?.permissions ?? []
    const effect = (id: string, action: string) => Permission.evaluate(action, "*", rules(id)).effect
    expect(effect("build", "shell")).toBe("ask")
    expect(effect("build", "edit")).toBe("ask")
    expect(effect("build", "read")).toBe("allow")
    expect(effect("build", "question")).toBe("allow")
    for (const id of ["yolo", "assistant"]) {
      expect(effect(id, "shell")).toBe("allow")
      expect(effect(id, "edit")).toBe("allow")
      expect(effect(id, "question")).toBe("allow")
    }
    // The retired assistant stays as a hidden copy of yolo so Sessions saved with it still load.
    const assistant = list.find((agent) => agent.id === DispatchAgentsPlugin.assistant)
    expect(assistant).toMatchObject({ hidden: true, mode: "primary" })
    expect(assistant?.system).toBeUndefined()
    expect(list.find((agent) => agent.id === DispatchAgentsPlugin.yolo)?.description).toBe(
      "Auto runs write, edit, and bash commands.",
    )
  })
})

describe("commands", () => {
  test("/deepReview and /merge substitute $ARGUMENTS into the prompt", async () => {
    const prompts: Array<{ sessionID: string; text: string }> = []
    const listed = await run(
      Effect.gen(function* () {
        const commands = yield* Command.Service
        const session = {
          prompt: (input: { sessionID: string; text: string }) => Effect.sync(() => prompts.push(input)),
        }
        yield* DispatchCommandsPlugin.Plugin.effect(context({ command: { transform: commands.transform }, session }))
        const invoke = (name: string, text: string) =>
          commands.execute({
            name,
            invocation: { sessionID: "ses_1" as never, prompt: { text } as never, delivery: "steer" as never },
          })
        yield* invoke("merge", "  develop ")
        yield* invoke("deepReview", "")
        return yield* commands.list()
      }),
    )
    expect(listed.map((command) => command.name)).toEqual(["deepReview", "merge"])
    expect(prompts[0]?.text).toContain("use that instead of auto-detecting the parent: develop\n")
    expect(prompts[0]?.text).not.toContain("$ARGUMENTS")
    expect(prompts[1]?.text).toContain("Additional instructions from the user: \n")
  })

  test("a template without $ARGUMENTS gets the arguments appended", () => {
    expect(DispatchCommandsPlugin.render("Do it.", " now ")).toBe("Do it.\n\nnow")
    expect(DispatchCommandsPlugin.render("Do it.", "")).toBe("Do it.")
  })
})

describe("worktree strategy", () => {
  const repository = async () => {
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-wt-")))
    const root = path.join(parent, "app")
    mkdirSync(root)
    writeFileSync(path.join(root, "README.md"), "hi\n")
    const git = (...args: string[]) => Effect.runPromise(DispatchProcess.git(args, root))
    await git("init", "-q", "-b", "main")
    await git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".")
    await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
    return { parent, root, git }
  }

  const strategy = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const captured: WorktreeDefinition[] = []
        yield* DispatchWorktreePlugin.Plugin.effect(
          context({
            worktree: {
              transform: (callback: (editor: { add: (definition: WorktreeDefinition) => void }) => void) =>
                Effect.sync(() => {
                  callback({ add: (definition) => captured.push(definition) })
                  return { dispose: Effect.void }
                }),
            },
          }),
        )
        return captured[0]
      }).pipe(Effect.scoped),
    )

  test("creates a sibling <repo>-<slug> on a new <slug> branch and removes both", async () => {
    const repo = await repository()
    const definition = await strategy()
    expect(definition?.id).toBe("dispatch")
    if (!definition) return
    // Core suggests a directory under its data dir; only the basename (the slug) is used.
    const created = await Effect.runPromise(
      definition.create({ sourceDirectory: repo.root, directory: "/data/worktree/abc/Feature X" }),
    )
    expect(created.directory).toBe(path.join(repo.parent, "app-feature-x"))
    const branch = await Effect.runPromise(DispatchProcess.git(["branch", "--show-current"], created.directory))
    expect(branch.stdout.trim()).toBe("feature-x")

    // A taken name moves to the next free suffix for both the directory and the branch.
    const second = await Effect.runPromise(
      definition.create({ sourceDirectory: repo.root, directory: "/data/worktree/abc/feature-x" }),
    )
    expect(second.directory).toBe(path.join(repo.parent, "app-feature-x-2"))

    const listed = await Effect.runPromise(definition.list(repo.root))
    expect(listed.map((entry) => entry.type)).toEqual(["root", "worktree", "worktree"])

    await Effect.runPromise(definition.remove({ directory: created.directory, force: false }))
    expect(existsSync(created.directory)).toBe(false)
    const branches = await repo.git("branch", "--list", "feature-x")
    expect(branches.stdout.trim()).toBe("")
  })

  test("removing a dirty worktree without force reports that force is required", async () => {
    const repo = await repository()
    const definition = await strategy()
    if (!definition) return
    const created = await Effect.runPromise(
      definition.create({ sourceDirectory: repo.root, directory: "/data/worktree/abc/dirty" }),
    )
    writeFileSync(path.join(created.directory, "README.md"), "changed\n")
    const exit = await Effect.runPromiseExit(definition.remove({ directory: created.directory, force: false }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('"forceRequired":true')
    expect(existsSync(created.directory)).toBe(true)
  })

  test("slugs are branch-safe", () => {
    expect(DispatchWorktreePlugin.slugify("  My Feature/Thing!! ")).toBe("my-feature-thing")
    expect(DispatchWorktreePlugin.slugify("..")).toBe("worktree")
  })
})
