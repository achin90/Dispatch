export * as SdkPermission from "./permission.js"

import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/core/agent"
import { FileAccess } from "@opencode/core/file-access"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import type { Tool } from "@opencode/core/tool"
import { fileDiff } from "@opencode/core/tool/plugin/file-diff"
import { Cause, Effect, Exit, Option } from "effect"
import { readFile } from "node:fs/promises"
import { SdkAdapter } from "../sdk/adapter.js"
import type { DispatchBridge } from "../bridge/service.js"

/** Services the SDK callbacks reach through the runner's captured context. */
export type Requirements =
  | Agent.Service
  | FileAccess.Service
  | Form.Service
  | Location.Service
  | Permission.Service
  | PermissionSaved.Service
  | SessionStore.Service

/** Runs an Effect from plain SDK callback code with the runner's captured Location context. */
export type Run = <A, E>(effect: Effect.Effect<A, E, Requirements>, signal?: AbortSignal) => Promise<A>

/**
 * Where each SDK tool call is published. `canUseTool` can fire before the stream reader has
 * opened the tool part, so permission requests wait for the call to appear.
 */
export function directory() {
  const entries = new Map<string, { readonly promise: Promise<Source>; resolve: (value: Source) => void }>()
  const entry = (id: string) => {
    const existing = entries.get(id)
    if (existing) return existing
    let resolve: (value: Source) => void = () => {}
    const promise = new Promise<Source>((done) => {
      resolve = done
    })
    const created = { promise, resolve }
    entries.set(id, created)
    return created
  }
  return {
    register: (id: string, source: Source) => entry(id).resolve(source),
    /** Waits up to `timeout` ms for the call to be published. */
    lookup: (id: string, timeout = 5_000) =>
      Promise.race([entry(id).promise, Bun.sleep(timeout).then(() => undefined)]),
  }
}

export type Directory = ReturnType<typeof directory>

export interface Source {
  readonly sessionID: SessionSchema.ID
  readonly messageID: string
}

export interface Options {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly run: Run
  readonly directory: Directory
  /** UI metadata computed before approval (edit diffs, answers), keyed by tool call id. */
  readonly metadata: Map<string, Tool.Metadata>
  /** Called when the user declines without feedback, which ends the turn as interrupted. */
  readonly onDecline?: () => void
  /** Dispatch bridge: offers prompts to a claude.ai mirror as well (see bridge/service.ts). */
  readonly remote?: DispatchBridge.Remote
}

/** The `canUseTool` bridge: every main-thread SDK tool call asks v2's Permission service. */
export function canUseTool(options: Options): CanUseTool {
  return async (toolName, input, call) => {
    if (call.signal.aborted) return { behavior: "deny", message: "Request aborted" }
    const source = await options.directory.lookup(call.toolUseID)
    // Subagent calls belong to a child session's tool part; ask on the parent without a source link.
    const invocation = {
      sessionID: options.sessionID,
      agent: options.agent,
      messageID: source && !call.agentID ? source.messageID : undefined,
      id: call.toolUseID,
      permissionID: Permission.ID.create(),
      formID: Form.ID.create(),
    }
    const extra = { tool: toolName, input, ...(call.agentID ? { agentID: call.agentID } : {}) }
    // Dispatch bridge: while mirrored, the prompt is offered to claude.ai too; first answer wins.
    const release = fanOut(options, toolName, input, invocation, call.agentID)
    try {
      const result =
        toolName === "AskUserQuestion"
          ? await options.run(question(input, invocation, options.metadata), call.signal)
          : decision(
              await options
                .run(authorize(toolName, input, invocation, extra, options.metadata).pipe(Effect.exit), call.signal)
                .catch((error: unknown) => Exit.die(error)),
              input,
            )
      if (result.behavior === "deny" && result.interrupt) options.onDecline?.()
      return result
    } finally {
      release()
    }
  }
}

/**
 * Dispatch bridge: offers this call's permission prompt or question to the Session's claude.ai
 * mirror. The remote answer goes through the same `reply` the TUI uses, so the one pending request
 * settles once and whichever surface answers first wins. Returns the cleanup that dismisses the
 * remote copy.
 */
function fanOut(
  options: Options,
  toolName: string,
  input: Record<string, unknown>,
  invocation: Invocation,
  agentID: string | undefined,
) {
  if (!options.remote) return () => {}
  if (toolName === "AskUserQuestion")
    return options.remote.question({
      sessionID: invocation.sessionID,
      formID: invocation.formID,
      prompts: SdkAdapter.questions(input),
      reply: (answer) =>
        options.run(
          Effect.gen(function* () {
            const forms = yield* Form.Service
            yield* forms.reply({ id: invocation.formID, answer })
          }),
        ),
    })
  return options.remote.permission({
    sessionID: invocation.sessionID,
    requestID: invocation.permissionID,
    toolName,
    input,
    toolUseID: invocation.id,
    ...(agentID ? { agentID } : {}),
    reply: (answer) =>
      options.run(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          yield* permission.reply({
            requestID: invocation.permissionID,
            reply: answer.allow ? "once" : "reject",
            ...(answer.message ? { message: answer.message } : {}),
          })
        }),
      ),
  })
}

interface Invocation {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly messageID: string | undefined
  readonly id: string
  /** Dispatch bridge: the ids this call's prompt is created with, so a mirror can answer it. */
  readonly permissionID: Permission.ID
  readonly formID: Form.ID
}

const assertSource = (invocation: Invocation) => ({
  id: invocation.permissionID,
  sessionID: invocation.sessionID,
  agent: invocation.agent,
  ...(invocation.messageID
    ? { source: { type: "tool" as const, messageID: invocation.messageID, id: invocation.id } }
    : {}),
})

/** Maps the bridge's exit to the SDK's answer. A plain decline is a defect upstream; feedback stays typed. */
export function decision(exit: Exit.Exit<void, unknown>, input: Record<string, unknown>): PermissionResult {
  if (Exit.isSuccess(exit)) return { behavior: "allow", updatedInput: input }
  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure instanceof Permission.CorrectedError)
    return { behavior: "deny", message: `User rejected permission with the following feedback: ${failure.feedback}` }
  if (failure instanceof Permission.BlockedError) return { behavior: "deny", message: failure.message }
  const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect
  // v2 ends the step when the user declines without feedback; interrupt keeps that behaviour.
  if (defect instanceof Permission.DeclinedError)
    return { behavior: "deny", message: "The user declined this tool call", interrupt: true }
  if (Cause.hasInterruptsOnly(exit.cause)) return { behavior: "deny", message: "Request aborted" }
  const error = failure ?? defect
  return { behavior: "deny", message: error instanceof Error ? error.message : "Permission denied" }
}

const authorize = Effect.fn("SdkPermission.authorize")(function* (
  toolName: string,
  input: Record<string, unknown>,
  invocation: Invocation,
  extra: Record<string, unknown>,
  stash: Map<string, Tool.Metadata>,
) {
  const permission = yield* Permission.Service
  const access = yield* FileAccess.Service
  const location = yield* Location.Service
  const context = {
    sessionID: invocation.sessionID,
    agent: invocation.agent,
    messageID: invocation.messageID ?? "",
    id: invocation.id,
  } as FileAccess.Invocation
  const file = SdkAdapter.filePath(toolName, input)
  if (file) {
    const target = yield* access.resolve({ path: file, kind: "file" })
    yield* access.authorizeExternal([target], context)
    const action = toolName === "Read" ? "read" : "edit"
    const preview = action === "edit" ? yield* editPreview(toolName, input, target) : undefined
    if (preview) stash.set(invocation.id, { files: [preview] })
    return yield* permission.assert({
      action,
      resources: [target.resource],
      save: ["*"],
      metadata: { ...extra, ...(preview ? { files: [preview] } : {}) },
      ...assertSource(invocation),
    })
  }
  const search = SdkAdapter.searchPath(toolName, input)
  if (search) yield* access.authorizeExternal([yield* access.resolve({ path: search, kind: "directory" })], context)
  if (toolName === "Bash" && typeof input.command === "string") {
    const shell = process.env.SHELL ?? "/bin/bash"
    const parsed = yield* ShellParse.scanPortable(input.command, shell, location.directory).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    const commands = parsed?.commands.length ? parsed.commands : [{ resource: input.command, save: input.command }]
    return yield* permission.assert({
      action: "shell",
      resources: commands.map((command) => command.resource),
      save: commands.map((command) => command.save),
      metadata: extra,
      ...assertSource(invocation),
    })
  }
  const mapped = SdkAdapter.permission(toolName, input)
  return yield* permission.assert({
    action: mapped.action,
    resources: mapped.resources,
    save: mapped.action === "subagent" || mapped.action === "skill" ? mapped.resources : ["*"],
    metadata: extra,
    ...assertSource(invocation),
  })
})

/** The diff an Edit/Write would apply, computed before approval so the prompt and tool part can show it. */
const editPreview = Effect.fnUntraced(function* (
  toolName: string,
  input: Record<string, unknown>,
  target: FileAccess.Target,
) {
  const before = yield* Effect.promise(() => readFile(target.absolute, "utf8").catch(() => undefined))
  if (toolName === "Write" && typeof input.content === "string")
    return fileDiff(target.resource, before ?? "", input.content, before === undefined ? "added" : "modified")
  if ((toolName !== "Edit" && toolName !== "MultiEdit") || before === undefined) return undefined
  const edits = Array.isArray(input.edits)
    ? (input.edits as Array<Record<string, unknown>>)
    : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }]
  const after = edits.reduce((content, edit) => {
    const from = typeof edit.old_string === "string" ? edit.old_string : ""
    const to = typeof edit.new_string === "string" ? edit.new_string : ""
    if (!from) return content
    return edit.replace_all === true ? content.replaceAll(from, to) : content.replace(from, to)
  }, before)
  return after === before ? undefined : fileDiff(target.resource, before, after)
})

/** AskUserQuestion → a v2 question form, rendered by the TUI's question UI. */
const question = Effect.fn("SdkPermission.question")(function* (
  input: Record<string, unknown>,
  invocation: Invocation,
  stash: Map<string, Tool.Metadata>,
) {
  const permission = yield* Permission.Service
  const forms = yield* Form.Service
  const prompts = SdkAdapter.questions(input)
  if (prompts.length === 0) return { behavior: "deny", message: "No questions provided" } satisfies PermissionResult
  const allowed = yield* permission
    .assert({ action: "question", resources: ["*"], ...assertSource(invocation) })
    .pipe(Effect.exit)
  if (Exit.isFailure(allowed)) return decision(allowed, input)
  const state = yield* forms
    .ask({
      id: invocation.formID,
      sessionID: invocation.sessionID,
      title: "Questions",
      metadata: {
        kind: "question",
        ...(invocation.messageID ? { tool: { messageID: invocation.messageID, id: invocation.id } } : {}),
      },
      fields: [toField(prompts[0], 0), ...prompts.slice(1).map((prompt, index) => toField(prompt, index + 1))],
    })
    .pipe(Effect.orDie)
  if (state.status === "cancelled")
    return {
      behavior: "deny",
      message: state.message ?? "The user dismissed this question",
      ...(state.message === undefined ? { interrupt: true } : {}),
    } satisfies PermissionResult
  const answers = prompts.map((_, index) => {
    const value = state.answer[`q${index}`]
    if (value === undefined) return []
    if (typeof value === "object") return Array.from(value as Iterable<unknown>, String)
    return [String(value)]
  })
  stash.set(invocation.id, { answers })
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: Object.fromEntries(prompts.map((prompt, index) => [prompt.question, answers[index].join(", ")])),
    },
  } satisfies PermissionResult
})

function toField(prompt: SdkAdapter.Question, index: number): Form.Field {
  return {
    key: `q${index}`,
    title: prompt.header,
    description: prompt.question,
    type: prompt.multiple ? "multiselect" : "string",
    options: prompt.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    custom: true,
  }
}

/** Combines per-resource decisions: any deny wins, all-allow allows, anything else asks. */
export function subagentDecision(rules: Permission.Ruleset, action: string, resources: readonly string[]) {
  const effects = resources.map((resource) => Permission.evaluate(action, resource, rules).effect)
  if (effects.includes("deny")) return "deny" as const
  if (effects.every((effect) => effect === "allow")) return "allow" as const
  return "ask" as const
}

/**
 * PreToolUse hook. It forces Agent/Task subagents and Bash commands to run synchronously, and applies
 * the parent's rules to subagent tool calls, which never reach `canUseTool` unless the hook answers
 * "ask". Main-thread calls pass through to `canUseTool`.
 *
 * Each drain turn is a one-shot `query()`, and the CLI kills background shells a few seconds after
 * its result, so a backgrounded command never finishes while the model reports it as running or done.
 */
export function subagentHook(options: Pick<Options, "sessionID" | "agent" | "run">): HookCallback {
  return async (event) => {
    if (event.hook_event_name !== "PreToolUse") return { continue: true }
    const input =
      typeof event.tool_input === "object" && event.tool_input !== null
        ? (event.tool_input as Record<string, unknown>)
        : {}
    if (SdkAdapter.isSubagentTool(event.tool_name) && input.run_in_background !== false)
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...input, run_in_background: false },
        },
      }
    const updatedInput =
      event.tool_name === "Bash" && input.run_in_background === true ? { ...input, run_in_background: false } : undefined
    if (!event.agent_id)
      return updatedInput ? { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } } : { continue: true }
    const decided = await options.run(
      Effect.gen(function* () {
        const rules = yield* sessionRules(options.sessionID, options.agent)
        const requests = yield* subagentRequests(event.tool_name, input)
        const decisions = requests.map((request) => subagentDecision(rules, request.action, request.resources))
        if (decisions.includes("deny")) return "deny" as const
        if (decisions.every((item) => item === "allow")) return "allow" as const
        return "ask" as const
      }).pipe(Effect.orElseSucceed(() => "ask" as const)),
    )
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decided,
        permissionDecisionReason:
          decided === "allow"
            ? "Inherited from parent session permissions"
            : `Subagent tool '${event.tool_name}' ${decided === "deny" ? "denied" : "not pre-approved"} by parent rules`,
        ...(updatedInput ? { updatedInput } : {}),
      },
    }
  }
}

/** Agent rules, then Session rules, then saved approvals, in the order Permission evaluates them. */
const sessionRules = Effect.fn("SdkPermission.sessionRules")(function* (
  sessionID: SessionSchema.ID,
  agentID: Agent.ID,
) {
  const agents = yield* Agent.Service
  const store = yield* SessionStore.Service
  const saved = yield* PermissionSaved.Service
  const location = yield* Location.Service
  const session = yield* store.get(sessionID)
  const agent = yield* agents.resolve(session?.agent ?? agentID)
  const approvals = (yield* saved.list({ projectID: location.project.id })).map(
    (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
  )
  return Permission.merge(agent?.permissions ?? [], session?.permissions ?? [], approvals)
})

const subagentRequests = Effect.fn("SdkPermission.subagentRequests")(function* (
  toolName: string,
  input: Record<string, unknown>,
) {
  const access = yield* FileAccess.Service
  const file = SdkAdapter.filePath(toolName, input)
  if (!file) return [SdkAdapter.permission(toolName, input)]
  const target = yield* access.resolve({ path: file, kind: "file" })
  return [
    ...(target.externalDirectory
      ? [{ action: "external_directory", resources: [target.externalDirectory.resource] }]
      : []),
    { action: toolName === "Read" ? "read" : "edit", resources: [target.resource] },
  ]
})
