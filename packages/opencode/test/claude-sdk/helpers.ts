/**
 * Mock factories for Claude Agent SDK message types.
 * Used by all test phases to simulate query() responses without spawning a real subprocess.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  ModelUsage,
  NonNullableUsage,
} from "@anthropic-ai/claude-agent-sdk"

// Derive Beta types from SDKAssistantMessage.message (BetaMessage) to avoid
// importing directly from @anthropic-ai/sdk which is only a transitive dep.
type BetaContentBlock = SDKAssistantMessage["message"]["content"][number]
type BetaTextBlock = Extract<BetaContentBlock, { type: "text" }>
type BetaThinkingBlock = Extract<BetaContentBlock, { type: "thinking" }>
type BetaToolUseBlock = Extract<BetaContentBlock, { type: "tool_use" }>
import type { UUID } from "crypto"

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

export function uuid(): UUID {
  return crypto.randomUUID() as UUID
}

export function sessionId(): string {
  return `session-${crypto.randomUUID()}`
}

// ---------------------------------------------------------------------------
// Content block factories
// ---------------------------------------------------------------------------

export function textBlock(text: string, overrides?: Partial<BetaTextBlock>): BetaTextBlock {
  return {
    type: "text",
    text,
    citations: null,
    ...overrides,
  }
}

export function thinkingBlock(thinking: string, overrides?: Partial<BetaThinkingBlock>): BetaThinkingBlock {
  return {
    type: "thinking",
    thinking,
    signature: "mock-signature",
    ...overrides,
  }
}

export function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  overrides?: Partial<BetaToolUseBlock>,
): BetaToolUseBlock {
  return {
    type: "tool_use",
    id: `toolu_${crypto.randomUUID().slice(0, 12)}`,
    name,
    input,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Usage factories
// ---------------------------------------------------------------------------

function defaultBetaUsage() {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    iterations: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  } as const
}

function defaultNonNullableUsage(): NonNullableUsage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "us",
    iterations: [],
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  }
}

function defaultModelUsage(overrides?: Partial<ModelUsage>): ModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.001,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

export function assistantMessage(
  content: BetaContentBlock[],
  overrides?: Partial<SDKAssistantMessage>,
): SDKAssistantMessage {
  const sid = overrides?.session_id ?? sessionId()
  return {
    type: "assistant",
    uuid: uuid(),
    session_id: sid,
    parent_tool_use_id: null,
    message: {
      id: `msg_${crypto.randomUUID().slice(0, 12)}`,
      type: "message",
      role: "assistant",
      content,
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: defaultBetaUsage(),
      container: null,
      context_management: null,
    },
    ...overrides,
  }
}

export function resultSuccess(overrides?: Partial<SDKResultSuccess>): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    uuid: uuid(),
    session_id: sessionId(),
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage: defaultNonNullableUsage(),
    modelUsage: {
      "claude-sonnet-4-20250514": defaultModelUsage(),
    },
    permission_denials: [],
    ...overrides,
  }
}

export function resultError(
  subtype: SDKResultError["subtype"] = "error_during_execution",
  errors: string[] = ["Something went wrong"],
  overrides?: Partial<SDKResultError>,
): SDKResultError {
  return {
    type: "result",
    subtype,
    uuid: uuid(),
    session_id: sessionId(),
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.0005,
    usage: defaultNonNullableUsage(),
    modelUsage: {},
    permission_denials: [],
    errors,
    ...overrides,
  }
}

export function resultMessage(
  subtype: "success" | SDKResultError["subtype"] = "success",
  overrides?: Partial<SDKResultMessage>,
): SDKResultMessage {
  if (subtype === "success") {
    return resultSuccess(overrides as Partial<SDKResultSuccess>)
  }
  return resultError(subtype, undefined, overrides as Partial<SDKResultError>)
}

export function systemMessage(overrides?: Partial<SDKSystemMessage>): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: uuid(),
    session_id: sessionId(),
    apiKeySource: "user",
    claude_code_version: "2.1.81",
    cwd: "/tmp/test",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    mcp_servers: [],
    model: "claude-sonnet-4-20250514",
    permissionMode: "default",
    slash_commands: [],
    output_style: "concise",
    skills: [],
    plugins: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Sequence builder + fake query generator
// ---------------------------------------------------------------------------

export async function* messageSequence(...messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const msg of messages) {
    yield msg
  }
}

/**
 * Simple text response: system → assistant(text) → result(success)
 */
export function simpleTextResponse(text: string, sid?: string): AsyncGenerator<SDKMessage, void> {
  const s = sid ?? sessionId()
  return messageSequence(
    systemMessage({ session_id: s }),
    assistantMessage([textBlock(text)], { session_id: s }),
    resultSuccess({ session_id: s, result: text }),
  )
}

/**
 * Tool call response: system → assistant(tool_use) → assistant(text after tool) → result(success)
 *
 * Note: In the real Agent SDK, tool results appear as user messages with tool_result content.
 * For testing the message mapping layer, we include the tool_use in the assistant message
 * and the final text response separately.
 */
export function toolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  finalText: string,
  sid?: string,
): AsyncGenerator<SDKMessage, void> {
  const s = sid ?? sessionId()
  return messageSequence(
    systemMessage({ session_id: s }),
    assistantMessage([toolUseBlock(toolName, input)], {
      session_id: s,
      message: {
        id: `msg_${crypto.randomUUID().slice(0, 12)}`,
        type: "message",
        role: "assistant",
        content: [toolUseBlock(toolName, input)],
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: defaultBetaUsage(),
        container: null,
        context_management: null,
      },
    }),
    assistantMessage([textBlock(finalText)], { session_id: s }),
    resultSuccess({ session_id: s, result: finalText }),
  )
}

/**
 * Thinking then text: system → assistant(thinking + text) → result(success)
 */
export function thinkingThenTextResponse(
  thinking: string,
  text: string,
  sid?: string,
): AsyncGenerator<SDKMessage, void> {
  const s = sid ?? sessionId()
  return messageSequence(
    systemMessage({ session_id: s }),
    assistantMessage([thinkingBlock(thinking), textBlock(text)], { session_id: s }),
    resultSuccess({ session_id: s, result: text }),
  )
}

/**
 * Error response: system → result(error)
 */
export function errorResponse(
  errorSubtype: SDKResultError["subtype"] = "error_during_execution",
  errors: string[] = ["Something went wrong"],
  sid?: string,
): AsyncGenerator<SDKMessage, void> {
  const s = sid ?? sessionId()
  return messageSequence(systemMessage({ session_id: s }), resultError(errorSubtype, errors, { session_id: s }))
}

// ---------------------------------------------------------------------------
// Subagent message factories
// ---------------------------------------------------------------------------

/**
 * Creates an assistant message with parent_tool_use_id set (subagent message).
 */
export function subagentAssistantMessage(
  content: BetaContentBlock[],
  parentToolUseId: string,
  overrides?: Partial<SDKAssistantMessage>,
): SDKAssistantMessage {
  return assistantMessage(content, {
    parent_tool_use_id: parentToolUseId,
    ...overrides,
  })
}

/**
 * Creates a task_started system message.
 */
export function taskStartedMessage(
  toolUseId: string,
  description: string,
  overrides?: Record<string, unknown>,
): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: `task_${crypto.randomUUID().slice(0, 12)}`,
    tool_use_id: toolUseId,
    description,
    uuid: uuid(),
    session_id: sessionId(),
    ...overrides,
  } as unknown as SDKMessage
}

/**
 * Creates a task_progress system message.
 */
export function taskProgressMessage(
  toolUseId: string,
  description: string,
  toolUses: number,
  overrides?: Record<string, unknown>,
): SDKMessage {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: `task_${crypto.randomUUID().slice(0, 12)}`,
    tool_use_id: toolUseId,
    description,
    usage: {
      total_tokens: toolUses * 100,
      tool_uses: toolUses,
      duration_ms: toolUses * 500,
    },
    uuid: uuid(),
    session_id: sessionId(),
    ...overrides,
  } as unknown as SDKMessage
}

/**
 * Creates a task_notification system message.
 */
export function taskNotificationMessage(
  toolUseId: string,
  status: "completed" | "failed" | "stopped",
  summary: string,
  overrides?: Record<string, unknown>,
): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: `task_${crypto.randomUUID().slice(0, 12)}`,
    tool_use_id: toolUseId,
    status,
    output_file: "",
    summary,
    uuid: uuid(),
    session_id: sessionId(),
    ...overrides,
  } as unknown as SDKMessage
}
