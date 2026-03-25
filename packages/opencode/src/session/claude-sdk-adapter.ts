/**
 * Pure adapter functions that convert Claude Agent SDK messages into MessageV2 parts.
 * No side effects — these are stateless mapping functions used by the session loop.
 */

import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type {
  BetaContentBlock,
  BetaTextBlock,
  BetaThinkingBlock,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { MessageV2 } from "./message-v2"
import { PartID, SessionID, MessageID } from "./schema"

// ---------------------------------------------------------------------------
// Content block type guards
// ---------------------------------------------------------------------------

export function isTextBlock(block: BetaContentBlock): block is BetaTextBlock {
  return block.type === "text"
}

export function isThinkingBlock(block: BetaContentBlock): block is BetaThinkingBlock {
  return block.type === "thinking"
}

export function isToolUseBlock(block: BetaContentBlock): block is BetaToolUseBlock {
  return block.type === "tool_use"
}

// ---------------------------------------------------------------------------
// Content block → MessageV2 Part mappers
// ---------------------------------------------------------------------------

export function textBlockToPart(
  block: BetaTextBlock,
  sessionID: SessionID,
  messageID: MessageID,
): MessageV2.TextPart {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text: block.text,
    time: {
      start: Date.now(),
      end: Date.now(),
    },
  }
}

export function thinkingBlockToPart(
  block: BetaThinkingBlock,
  sessionID: SessionID,
  messageID: MessageID,
): MessageV2.ReasoningPart {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "reasoning",
    text: block.thinking,
    time: {
      start: Date.now(),
      end: Date.now(),
    },
  }
}

export function toolUseBlockToPart(
  block: BetaToolUseBlock,
  sessionID: SessionID,
  messageID: MessageID,
): MessageV2.ToolPart {
  const input = (block.input ?? {}) as Record<string, unknown>
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: block.id,
    tool: block.name,
    state: {
      status: "running",
      input,
      time: {
        start: Date.now(),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Convert a single content block to a MessageV2 Part (or null if unsupported)
// ---------------------------------------------------------------------------

export type MappedPart = MessageV2.TextPart | MessageV2.ReasoningPart | MessageV2.ToolPart

export function contentBlockToPart(
  block: BetaContentBlock,
  sessionID: SessionID,
  messageID: MessageID,
): MappedPart | null {
  if (isTextBlock(block)) {
    return textBlockToPart(block, sessionID, messageID)
  }
  if (isThinkingBlock(block)) {
    return thinkingBlockToPart(block, sessionID, messageID)
  }
  if (isToolUseBlock(block)) {
    return toolUseBlockToPart(block, sessionID, messageID)
  }
  // Unsupported block types (redacted_thinking, server_tool_use, etc.) are skipped
  return null
}

// ---------------------------------------------------------------------------
// Convert an SDKAssistantMessage into an array of MessageV2 Parts
// ---------------------------------------------------------------------------

export function assistantMessageToParts(
  msg: SDKAssistantMessage,
  sessionID: SessionID,
  messageID: MessageID,
): MappedPart[] {
  return msg.message.content
    .map((block) => contentBlockToPart(block, sessionID, messageID))
    .filter((part): part is MappedPart => part !== null)
}

// ---------------------------------------------------------------------------
// Extract completion metadata from SDKResultMessage
// ---------------------------------------------------------------------------

export interface CompletionMetadata {
  success: boolean
  duration_ms: number
  duration_api_ms: number
  total_cost_usd: number
  num_turns: number
  tokens: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
  result?: string
  errors?: string[]
  stop_reason: string | null
}

export function resultMessageToMetadata(msg: SDKResultMessage): CompletionMetadata {
  const base: CompletionMetadata = {
    success: !msg.is_error,
    duration_ms: msg.duration_ms,
    duration_api_ms: msg.duration_api_ms,
    total_cost_usd: msg.total_cost_usd,
    num_turns: msg.num_turns,
    tokens: {
      input: msg.usage.input_tokens,
      output: msg.usage.output_tokens,
      cache_read: msg.usage.cache_read_input_tokens ?? 0,
      cache_write: msg.usage.cache_creation_input_tokens ?? 0,
    },
    stop_reason: msg.stop_reason,
  }

  if (msg.subtype === "success") {
    base.result = (msg as SDKResultSuccess).result
  } else {
    base.errors = (msg as Exclude<SDKResultMessage, SDKResultSuccess>).errors
  }

  return base
}

// ---------------------------------------------------------------------------
// Extract init metadata from SDKSystemMessage
// ---------------------------------------------------------------------------

export interface InitMetadata {
  session_id: string
  model: string
  tools: string[]
  cwd: string
  permission_mode: string
}

export function systemMessageToMetadata(msg: SDKSystemMessage): InitMetadata {
  return {
    session_id: msg.session_id,
    model: msg.model,
    tools: msg.tools,
    cwd: msg.cwd,
    permission_mode: msg.permissionMode,
  }
}
