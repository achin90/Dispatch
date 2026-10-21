export * as SdkWriter from "./writer.js"

import type { SDKAssistantMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk"
import { LLMEvent, Usage } from "@opencode/ai"
import type { Bus } from "@opencode/core/bus"
import type { Agent } from "@opencode/core/agent"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { createLLMEventPublisher } from "@opencode/core/session/runner/publish-llm-event"
import type { SessionSchema } from "@opencode/core/session/schema"
import { SessionUsage } from "@opencode/core/session/usage"
import type { Tool } from "@opencode/core/tool"
import type { Model } from "@opencode/schema/model"
import type { SessionError } from "@opencode/schema/session-error"
import { Clock, Effect } from "effect"
import { SdkAdapter } from "../sdk/adapter.js"

type StreamEvent = SDKPartialAssistantMessage["event"]
type ContentBlock = SDKAssistantMessage["message"]["content"][number]
type ApiUsage = Partial<{
  input_tokens: number | null
  output_tokens: number | null
  cache_read_input_tokens: number | null
  cache_creation_input_tokens: number | null
}>

export interface ToolResultBlock {
  readonly tool_use_id: string
  readonly content?: unknown
  readonly is_error?: boolean
}

/** A tool call as it was published, so results and permission requests can find their part. */
export interface Call {
  readonly id: string
  /** SDK tool name, e.g. "Bash". */
  readonly sdkName: string
  readonly input: Record<string, unknown>
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
}

export interface Input {
  readonly bus: Pick<Bus.Interface, "publish">
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly cost: Model.Info["cost"]
  /** Called when a tool call is published, before any result can arrive. */
  readonly onCall: (call: Call) => void
}

type Block =
  | { readonly kind: "text"; readonly id: string }
  // Reasoning opens on its first text: models that omit thinking stream empty blocks.
  | { readonly kind: "reasoning"; readonly id: string; started: boolean }
  | { readonly kind: "tool"; readonly id: string; readonly sdkName: string; json: string }
  | { readonly kind: "skip" }

interface Turn {
  readonly sdkID: string
  readonly assistantMessageID: SessionMessage.ID
  readonly publisher: ReturnType<typeof createLLMEventPublisher>
  readonly blocks: Map<number, Block>
  /** Content blocks already published from stream events; complete messages then skip them. */
  readonly published: Set<number>
  readonly calls: Map<string, Call>
  readonly settled: Set<string>
  /** Raw usage of this API call, replaced (never summed) as later frames report it. */
  usage: ApiUsage
  stop: string | null | undefined
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "The SDK did not return a tool result" } as const

/**
 * Writes one opencode Session's view of a Claude Agent SDK query.
 *
 * Each top-level API call (one `message.id`) becomes one v2 assistant message with its own
 * `createLLMEventPublisher`, one `step-finish` and one `Step.Ended`, so per-message tokens are that
 * call's usage and the TUI's context gauge reads the latest call. All tools are provider-executed:
 * their results come from the SDK's tool_result blocks, published on the call's own message.
 */
export function make(input: Input) {
  let turn: Turn | undefined

  const usageOf = (raw: ApiUsage) => {
    const input = raw.input_tokens ?? 0
    const read = raw.cache_read_input_tokens ?? 0
    const write = raw.cache_creation_input_tokens ?? 0
    return Usage.from({
      inputTokens: input + read + write,
      nonCachedInputTokens: input,
      cacheReadInputTokens: read,
      cacheWriteInputTokens: write,
      outputTokens: raw.output_tokens ?? 0,
      contextTokens: input + read + write,
    })
  }

  const merge = (current: ApiUsage, next: ApiUsage | null | undefined): ApiUsage =>
    next
      ? Object.fromEntries(
          Object.entries({ ...current, ...next }).filter(([, value]) => value !== null && value !== undefined),
        )
      : current

  const open = Effect.fnUntraced(function* (sdkID: string) {
    if (turn?.sdkID === sdkID) return turn
    if (turn) yield* close()
    const assistantMessageID = SessionMessage.ID.create()
    const next: Turn = {
      sdkID,
      assistantMessageID,
      publisher: createLLMEventPublisher(input.bus, {
        sessionID: input.sessionID,
        assistantMessageID,
        agent: input.agent,
        model: input.model,
        providerMetadataKey: "anthropic",
        started: yield* Clock.currentTimeMillis,
      }),
      blocks: new Map(),
      published: new Set(),
      calls: new Map(),
      settled: new Set(),
      usage: {},
      stop: undefined,
    }
    turn = next
    yield* next.publisher.startAssistant()
    return next
  })

  const call = Effect.fnUntraced(function* (current: Turn, id: string, sdkName: string, raw: Record<string, unknown>) {
    const name = sdkName === "advisor" ? "advisor" : SdkAdapter.normalizeTool(sdkName)
    const published: Call = {
      id,
      sdkName,
      input: raw,
      sessionID: input.sessionID,
      assistantMessageID: current.assistantMessageID,
    }
    current.calls.set(id, published)
    input.onCall(published)
    yield* current.publisher.publish(
      LLMEvent.toolCall({
        id,
        name,
        input: sdkName === "advisor" ? {} : SdkAdapter.normalizeInput(sdkName, raw),
        providerExecuted: true,
      }),
    )
  })

  const startTool = Effect.fnUntraced(function* (current: Turn, id: string, sdkName: string) {
    const name = sdkName === "advisor" ? "advisor" : SdkAdapter.normalizeTool(sdkName)
    yield* current.publisher.publish(LLMEvent.toolInputStart({ id, name, providerExecuted: true }))
  })

  const reason = Effect.fnUntraced(function* (
    current: Turn,
    block: Extract<Block, { kind: "reasoning" }>,
    text: string,
  ) {
    if (!block.started) yield* current.publisher.publish(LLMEvent.reasoningStart({ id: block.id }))
    block.started = true
    yield* current.publisher.publish(LLMEvent.reasoningDelta({ id: block.id, text }))
  })

  /** One raw Messages API stream event (includePartialMessages). */
  const stream = Effect.fnUntraced(function* (event: StreamEvent) {
    if (event.type === "message_start") {
      const current = yield* open(event.message.id)
      current.usage = merge(current.usage, event.message.usage)
      return
    }
    const current = turn
    if (!current) return
    if (event.type === "message_delta") {
      current.usage = merge(current.usage, event.usage as ApiUsage)
      current.stop = event.delta.stop_reason ?? current.stop
      return
    }
    if (event.type === "content_block_start") {
      const block = event.content_block as {
        type: string
        id?: string
        name?: string
        text?: string
        thinking?: string
      }
      const id = `${current.sdkID}:${event.index}`
      current.published.add(event.index)
      if (block.type === "text") {
        current.blocks.set(event.index, { kind: "text", id })
        yield* current.publisher.publish(LLMEvent.textStart({ id }))
        if (block.text) yield* current.publisher.publish(LLMEvent.textDelta({ id, text: block.text }))
        return
      }
      if (block.type === "thinking") {
        const reasoning = { kind: "reasoning" as const, id, started: false }
        current.blocks.set(event.index, reasoning)
        if (block.thinking) yield* reason(current, reasoning, block.thinking)
        return
      }
      if ((block.type === "tool_use" && block.id && block.name) || SdkAdapter.isAdvisorCallBlock(block)) {
        const sdkName = SdkAdapter.isAdvisorCallBlock(block) ? "advisor" : block.name!
        current.blocks.set(event.index, { kind: "tool", id: block.id!, sdkName, json: "" })
        yield* startTool(current, block.id!, sdkName)
        return
      }
      if (SdkAdapter.isAdvisorResultBlock(block)) {
        current.blocks.set(event.index, { kind: "skip" })
        yield* advisorResult(current, block)
        return
      }
      current.blocks.set(event.index, { kind: "skip" })
      return
    }
    if (event.type === "content_block_delta") {
      const block = current.blocks.get(event.index)
      if (!block || block.kind === "skip") return
      const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
      if (block.kind === "text" && delta.type === "text_delta" && delta.text)
        yield* current.publisher.publish(LLMEvent.textDelta({ id: block.id, text: delta.text }))
      if (block.kind === "reasoning" && delta.type === "thinking_delta" && delta.thinking)
        yield* reason(current, block, delta.thinking)
      if (block.kind === "tool" && delta.type === "input_json_delta" && delta.partial_json) {
        block.json += delta.partial_json
        yield* current.publisher.publish(
          LLMEvent.toolInputDelta({
            id: block.id,
            name: block.sdkName === "advisor" ? "advisor" : SdkAdapter.normalizeTool(block.sdkName),
            text: delta.partial_json,
          }),
        )
      }
      return
    }
    if (event.type === "content_block_stop") {
      const block = current.blocks.get(event.index)
      if (!block || block.kind === "skip") return
      if (block.kind === "text") yield* current.publisher.publish(LLMEvent.textEnd({ id: block.id }))
      if (block.kind === "reasoning" && block.started)
        yield* current.publisher.publish(LLMEvent.reasoningEnd({ id: block.id }))
      if (block.kind === "tool") yield* call(current, block.id, block.sdkName, parseJson(block.json))
      current.blocks.set(event.index, { kind: "skip" })
    }
  })

  /** A complete assistant frame. Blocks already streamed are skipped; others (subagents, synthetic errors) publish here. */
  const assistant = Effect.fnUntraced(function* (message: SDKAssistantMessage) {
    const current = yield* open(message.message.id)
    current.usage = merge(current.usage, message.message.usage as ApiUsage)
    current.stop = message.message.stop_reason ?? current.stop
    const streamed = current.published.size > 0
    for (const block of message.message.content as ContentBlock[]) yield* completeBlock(current, block, streamed)
    if (message.error && !current.publisher.record().failure)
      yield* current.publisher.failAssistant({
        type: "provider.unknown",
        message: `Claude API error: ${message.error}`,
      })
  })

  const completeBlock = Effect.fnUntraced(function* (current: Turn, block: ContentBlock, streamed: boolean) {
    const raw: unknown = block
    if (SdkAdapter.isAdvisorResultBlock(raw)) return yield* advisorResult(current, raw)
    // Streamed calls carry every other block already; a call published twice would be a defect.
    if (streamed) return
    const id = `${current.sdkID}:${crypto.randomUUID()}`
    if (block.type === "text") {
      yield* current.publisher.publish(LLMEvent.textStart({ id }))
      yield* current.publisher.publish(LLMEvent.textEnd({ id, text: block.text }))
      return
    }
    if (block.type === "thinking") {
      if (!block.thinking) return
      yield* current.publisher.publish(LLMEvent.reasoningStart({ id }))
      yield* current.publisher.publish(LLMEvent.reasoningEnd({ id, text: block.thinking }))
      return
    }
    if (block.type === "tool_use") {
      if (current.calls.has(block.id)) return
      yield* startTool(current, block.id, block.name)
      yield* call(current, block.id, block.name, (block.input ?? {}) as Record<string, unknown>)
      return
    }
    if (SdkAdapter.isAdvisorCallBlock(raw) && !current.calls.has(raw.id)) {
      yield* startTool(current, raw.id, "advisor")
      yield* call(current, raw.id, "advisor", {})
    }
  })

  const advisorResult = Effect.fnUntraced(function* (current: Turn, block: SdkAdapter.AdvisorResultBlock) {
    const owner = ownerOf(block.tool_use_id) ?? current
    if (!owner.calls.has(block.tool_use_id) || owner.settled.has(block.tool_use_id)) return
    owner.settled.add(block.tool_use_id)
    const state = SdkAdapter.advisorResultState(block)
    if ("error" in state)
      return yield* owner.publisher.failTool(block.tool_use_id, { type: "tool.execution", message: state.error })
    yield* owner.publisher.toolExecution(block.tool_use_id, "advisor", {
      content: [{ type: "text", text: state.output }],
    })
  })

  // Results always settle on the message that published the call; only the open turn can own one.
  const ownerOf = (id: string) => (turn?.calls.has(id) ? turn : undefined)

  /** A tool_result block from an SDK user frame. */
  const result = Effect.fnUntraced(function* (block: ToolResultBlock, metadata?: Tool.Metadata) {
    const owner = ownerOf(block.tool_use_id)
    if (!owner || owner.settled.has(block.tool_use_id)) return
    const known = owner.calls.get(block.tool_use_id)!
    owner.settled.add(block.tool_use_id)
    const content = toContent(block.content)
    if (block.is_error)
      return yield* owner.publisher.failTool(
        block.tool_use_id,
        { type: "tool.execution", message: textOf(content) || "Tool failed" },
        metadata,
      )
    yield* owner.publisher.toolExecution(block.tool_use_id, toolName(known.sdkName), {
      content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
      ...(metadata === undefined ? {} : { metadata }),
    })
  })

  /** Live metadata for a running call, e.g. a subagent's child session. */
  const progress = Effect.fnUntraced(function* (id: string, metadata: Tool.Metadata) {
    const owner = ownerOf(id)
    if (!owner || owner.settled.has(id) || !owner.calls.has(id)) return
    yield* owner.publisher.progress(id, metadata)
  })

  const failCall = Effect.fnUntraced(function* (id: string, error: SessionError.Error, metadata?: Tool.Metadata) {
    const owner = ownerOf(id)
    if (!owner || owner.settled.has(id) || !owner.calls.has(id)) return
    owner.settled.add(id)
    yield* owner.publisher.failTool(id, error, metadata)
  })

  /** Ends the open API call normally: one step-finish and one Step.Ended with that call's usage. */
  const close = Effect.fnUntraced(function* () {
    const current = turn
    if (!current) return
    turn = undefined
    yield* current.publisher.failUnsettledTools(RESULT_MISSING)
    const finish = SdkAdapter.finishReason(current.stop)
    yield* current.publisher.publish(
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: finish, ...(current.stop ? { raw: current.stop } : {}) },
        usage: usageOf(current.usage),
      }),
    )
    yield* current.publisher.streamed()
    const record = current.publisher.record()
    const tokens = SessionUsage.tokens(usageOf(current.usage))
    const cost = SessionUsage.calculateCost(input.cost, tokens)
    if (record.failure) return yield* current.publisher.publishStepFailure({ cost, tokens })
    yield* input.bus.publish(SessionEvent.Step.Ended, {
      sessionID: input.sessionID,
      assistantMessageID: current.assistantMessageID,
      finish: record.finish?.finish ?? finish,
      ...(current.stop ? { rawFinish: current.stop } : {}),
      cost,
      tokens,
    })
  })

  /** Ends the open API call (or a new one, so the error is visible) as failed. */
  const fail = Effect.fnUntraced(function* (error: SessionError.Error, interrupted = false) {
    const current = turn ?? (yield* open(`failure:${crypto.randomUUID()}`))
    turn = undefined
    yield* current.publisher.failUnsettledTools(interrupted ? TOOLS_INTERRUPTED : error)
    yield* current.publisher.failAssistant(interrupted ? STEP_INTERRUPTED : error)
    const tokens = SessionUsage.tokens(usageOf(current.usage))
    yield* current.publisher.publishStepFailure({ tokens, cost: SessionUsage.calculateCost(input.cost, tokens) })
  })

  return {
    sessionID: input.sessionID,
    stream,
    assistant,
    result,
    progress,
    failCall,
    close,
    fail,
    /** Whether a call is open on this writer. */
    owns: (id: string) => ownerOf(id) !== undefined,
    hasOpenTurn: () => turn !== undefined,
  }
}

export type Writer = ReturnType<typeof make>

const toolName = (sdkName: string) => (sdkName === "advisor" ? "advisor" : SdkAdapter.normalizeTool(sdkName))

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** tool_result content (a string or Messages API content blocks) → v2 tool content. */
export function toContent(content: unknown): Tool.Content[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((item: unknown): Tool.Content[] => {
    if (typeof item !== "object" || item === null) return []
    const block = item as {
      type?: string
      text?: string
      source?: { type?: string; media_type?: string; data?: string }
    }
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }]
    if (block.type === "image" && block.source?.type === "base64" && block.source.media_type && block.source.data)
      return [
        {
          type: "file",
          uri: `data:${block.source.media_type};base64,${block.source.data}`,
          mime: block.source.media_type,
        },
      ]
    return []
  })
}

const textOf = (content: readonly Tool.Content[]) =>
  content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
