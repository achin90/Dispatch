import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

/** Factories for Claude Agent SDK frames, shaped like the CLI's output. */

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const base = { uuid: crypto.randomUUID(), session_id: "sdk-session" }

export const stream = (event: unknown, parent: string | null = null) =>
  ({ type: "stream_event", event, parent_tool_use_id: parent, ...base }) as unknown as SDKMessage

export const messageStart = (id: string, usage: Usage, parent: string | null = null) =>
  stream(
    {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage },
    },
    parent,
  )

export const blockStart = (index: number, block: Record<string, unknown>, parent: string | null = null) =>
  stream({ type: "content_block_start", index, content_block: block }, parent)

export const textDelta = (index: number, text: string, parent: string | null = null) =>
  stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } }, parent)

export const thinkingDelta = (index: number, thinking: string) =>
  stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } })

export const jsonDelta = (index: number, partial_json: string, parent: string | null = null) =>
  stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }, parent)

export const blockStop = (index: number, parent: string | null = null) =>
  stream({ type: "content_block_stop", index }, parent)

export const messageDelta = (stop: string, usage: Partial<Usage>, parent: string | null = null) =>
  stream({ type: "message_delta", delta: { stop_reason: stop }, usage }, parent)

/** A whole streamed text reply. */
export const textTurn = (id: string, text: string, usage: Usage, parent: string | null = null) => [
  messageStart(id, { ...usage, output_tokens: 1 }, parent),
  blockStart(0, { type: "text", text: "" }, parent),
  textDelta(0, text, parent),
  blockStop(0, parent),
  messageDelta("end_turn", { output_tokens: usage.output_tokens }, parent),
]

/** A streamed turn that calls one tool. */
export const toolTurn = (
  id: string,
  tool: { id: string; name: string; input: Record<string, unknown> },
  usage: Usage,
  parent: string | null = null,
) => [
  messageStart(id, { ...usage, output_tokens: 1 }, parent),
  blockStart(0, { type: "tool_use", id: tool.id, name: tool.name, input: {} }, parent),
  jsonDelta(0, JSON.stringify(tool.input), parent),
  blockStop(0, parent),
  messageDelta("tool_use", { output_tokens: usage.output_tokens }, parent),
]

/** A complete (non-streamed) assistant frame. */
export const assistant = (id: string, content: unknown[], usage: Usage, parent: string | null = null) =>
  ({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: null,
      usage,
    },
    parent_tool_use_id: parent,
    ...base,
  }) as unknown as SDKMessage

export const toolResult = (toolUseID: string, content: unknown, isError = false, parent: string | null = null) =>
  ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseID, content, is_error: isError }] },
    parent_tool_use_id: parent,
    ...base,
  }) as unknown as SDKMessage

export const system = (subtype: string, fields: Record<string, unknown> = {}) =>
  ({ type: "system", subtype, ...base, ...fields }) as unknown as SDKMessage

export const result = (fields: Record<string, unknown> = {}) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.5,
    usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 },
    modelUsage: {},
    permission_denials: [],
    ...base,
    ...fields,
  }) as unknown as SDKMessage
