export * as SdkRouter from "./router.js"

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Agent } from "@opencode/core/agent"
import type { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import type { SessionSchema } from "@opencode/core/session/schema"
import type { Tool } from "@opencode/core/tool"
import type { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { SdkAdapter } from "../sdk/adapter.js"
import type { SdkPermission } from "./permission.js"
import { SdkWriter } from "./writer.js"

export interface Child {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
}

export interface Input {
  readonly bus: Pick<Bus.Interface, "publish">
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly cost: Model.Info["cost"]
  readonly directory: SdkPermission.Directory
  /** Metadata computed by the permission bridge, merged into the tool's terminal event. */
  readonly metadata: Map<string, Tool.Metadata>
  /** Creates the child Session a subagent writes into, with its prompt as the first user message. */
  readonly createChild: (input: { readonly title: string; readonly prompt: string }) => Effect.Effect<Child>
  /** Records the SDK session uuid once the CLI reports it. */
  readonly onInit: (uuid: string) => Effect.Effect<void>
  /** The summary the PostCompact hook captured, if it has fired. */
  readonly compactSummary: () => string | undefined
  /** Whether the user declined a call; the error result that follows is then an interruption. */
  readonly declined?: () => boolean
}

const INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const

export type Outcome = { readonly type: "result"; readonly result: SDKResultMessage } | { readonly type: "incomplete" }

/**
 * Routes one query's SDK frames: top-level frames to the Session's writer, subagent frames
 * (`parent_tool_use_id`) to a child Session per Agent/Task call, tool results to the writer
 * that published the call, and compaction boundaries to v2 Compaction messages.
 */
export function make(input: Input) {
  const calls = new Map<string, SdkWriter.Call>()
  const writers = new Map<SessionSchema.ID, SdkWriter.Writer>()
  const children = new Map<string, SdkWriter.Writer>()
  let output = false
  let result: SDKResultMessage | undefined

  const writer = (sessionID: SessionSchema.ID, agent: Agent.ID) => {
    const created = SdkWriter.make({
      bus: input.bus,
      sessionID,
      agent,
      model: input.model,
      cost: input.cost,
      onCall: (call) => {
        calls.set(call.id, call)
        input.directory.register(call.id, { sessionID: call.sessionID, messageID: call.assistantMessageID })
      },
    })
    writers.set(sessionID, created)
    return created
  }
  const main = writer(input.sessionID, input.agent)

  const ownerOf = (id: string) => {
    const call = calls.get(id)
    return call ? writers.get(call.sessionID) : undefined
  }

  const child = Effect.fnUntraced(function* (toolUseID: string, subagentType?: string) {
    const existing = children.get(toolUseID)
    if (existing) return existing
    const call = calls.get(toolUseID)
    const description = typeof call?.input.description === "string" ? call.input.description : undefined
    const prompt = typeof call?.input.prompt === "string" ? call.input.prompt : ""
    const agent = (
      (typeof call?.input.subagent_type === "string" ? call.input.subagent_type : undefined) ??
      subagentType ??
      "general"
    ).toLowerCase()
    const created = yield* input.createChild({
      title: description ? `${description} (@${agent} subagent)` : "Subagent",
      prompt,
    })
    const next = writer(created.sessionID, created.agent)
    children.set(toolUseID, next)
    yield* (ownerOf(toolUseID) ?? main).progress(toolUseID, { sessionID: created.sessionID, status: "running" })
    return next
  })

  const target = (parent: string | null) => (parent === null ? Effect.succeed(main) : child(parent))

  const finishChild = Effect.fnUntraced(function* (toolUseID: string) {
    const found = children.get(toolUseID)
    if (!found) return undefined
    yield* found.close()
    return found.sessionID
  })

  const compacted = Effect.fnUntraced(function* (trigger: "manual" | "auto") {
    yield* main.close()
    yield* input.bus.publish(SessionEvent.Compaction.Started, { sessionID: input.sessionID, reason: trigger })
    // The PostCompact hook and the boundary frame race; give the hook a moment.
    for (let waited = 0; input.compactSummary() === undefined && waited < 3_000; waited += 50) yield* Effect.sleep(50)
    yield* input.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      reason: trigger,
      model: input.model,
      text: input.compactSummary() ?? "The conversation was compacted by the Claude Agent SDK.",
    })
  })

  const handle = Effect.fnUntraced(function* (message: SDKMessage) {
    switch (message.type) {
      case "stream_event":
        output = true
        return yield* (yield* target(message.parent_tool_use_id)).stream(message.event)
      case "assistant":
        output = true
        return yield* (yield* target(message.parent_tool_use_id)).assistant(message)
      case "user": {
        const content = message.message.content
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (typeof block !== "object" || block === null || block.type !== "tool_result") continue
          const call = calls.get(block.tool_use_id)
          const subagent = call && SdkAdapter.isSubagentTool(call.sdkName) ? yield* finishChild(call.id) : undefined
          const stashed = input.metadata.get(block.tool_use_id)
          input.metadata.delete(block.tool_use_id)
          const metadata =
            stashed || subagent ? { ...stashed, ...(subagent ? { sessionID: subagent } : {}) } : undefined
          yield* (ownerOf(block.tool_use_id) ?? main).result(block, metadata)
        }
        return
      }
      case "system":
        switch (message.subtype) {
          case "init":
            return yield* input.onInit(message.session_id)
          case "task_started": {
            // Background shells report tasks too; only Agent/Task calls get a child Session.
            const call = message.tool_use_id ? calls.get(message.tool_use_id) : undefined
            if (call && SdkAdapter.isSubagentTool(call.sdkName)) yield* child(call.id, message.subagent_type)
            return
          }
          case "task_progress": {
            if (!message.tool_use_id) return
            const sessionID = children.get(message.tool_use_id)?.sessionID
            return yield* (ownerOf(message.tool_use_id) ?? main).progress(message.tool_use_id, {
              ...(sessionID ? { sessionID } : {}),
              status: "running",
              toolUses: message.usage.tool_uses,
              ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            })
          }
          case "task_notification": {
            if (!message.tool_use_id || message.status === "completed") return
            const sessionID = yield* finishChild(message.tool_use_id)
            return yield* (ownerOf(message.tool_use_id) ?? main).failCall(
              message.tool_use_id,
              { type: "tool.execution", message: message.summary || `Subagent ${message.status}` },
              sessionID ? { sessionID } : undefined,
            )
          }
          case "compact_boundary":
            return yield* compacted(message.compact_metadata.trigger)
        }
        return
      case "result":
        result = message
        for (const found of children.values()) yield* found.close()
        if (!message.is_error) return yield* main.close()
        if (input.declined?.()) return yield* main.fail(INTERRUPTED, true)
        // Without output the runner decides: a stale resume retries silently.
        if (!output) return
        return yield* main.fail({
          type: "provider.unknown",
          message:
            ("errors" in message && message.errors.length > 0 ? message.errors.join("; ") : undefined) ??
            ("result" in message ? message.result : "The Claude Agent SDK reported an error"),
        })
    }
  })

  /** Fails every open message, after an interrupt or a failure that ended the stream early. */
  const abort = Effect.fnUntraced(function* (error: Parameters<SdkWriter.Writer["fail"]>[0], interrupted: boolean) {
    for (const found of children.values()) if (found.hasOpenTurn()) yield* found.fail(error, interrupted)
    if (main.hasOpenTurn() || !interrupted) yield* main.fail(error, interrupted)
  })

  return {
    handle,
    abort,
    /** Whether any model output reached the Session yet (a stale resume fails before any). */
    outputStarted: () => output,
    result: () => result,
  }
}

export type Router = ReturnType<typeof make>
