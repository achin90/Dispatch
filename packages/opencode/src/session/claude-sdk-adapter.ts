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

// Derive Beta types from SDKAssistantMessage.message (BetaMessage) to avoid
// importing directly from @anthropic-ai/sdk which is only a transitive dep.
type BetaContentBlock = SDKAssistantMessage["message"]["content"][number]
type BetaTextBlock = Extract<BetaContentBlock, { type: "text" }>
type BetaThinkingBlock = Extract<BetaContentBlock, { type: "thinking" }>
type BetaToolUseBlock = Extract<BetaContentBlock, { type: "tool_use" }>
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

export function textBlockToPart(block: BetaTextBlock, sessionID: SessionID, messageID: MessageID): MessageV2.TextPart {
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

// Map SDK PascalCase tool names to the lowercase names the TUI expects
export function normalizeTool(name: string): string {
  switch (name) {
    case "Read":
      return "read"
    case "Write":
      return "write"
    case "Edit":
      return "edit"
    case "Bash":
      return "bash"
    case "Glob":
      return "glob"
    case "Grep":
      return "grep"
    case "WebFetch":
      return "webfetch"
    case "WebSearch":
      return "websearch"
    case "CodeSearch":
      return "codesearch"
    case "NotebookEdit":
      return "notebook_edit"
    case "TodoWrite":
      return "todowrite"
    case "Task":
      return "task"
    case "Agent":
      return "agent"
    default:
      return name.toLowerCase()
  }
}

// Convert snake_case keys to camelCase so TUI components can access them
// e.g. file_path → filePath, old_string → oldString, replace_all → replaceAll
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

// The SDK sends all parameters the model specified, but the TUI tool
// components only display the primary field (e.g. filePath for Read/Edit)
// and use the input() helper to show "remaining" params as [key=value].
// In the original OpenCode flow, optional params like limit/offset/replaceAll
// aren't stored in the input object at all, so they never appear in brackets.
// We strip them here to match that behavior.
const TOOL_OMIT_KEYS: Record<string, string[]> = {
  read: ["limit", "offset"],
  edit: ["oldString", "newString", "replaceAll"],
  write: ["content"],
  bash: ["timeout", "description"],
  grep: ["include"],
}

export function normalizeInput(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  const omit = TOOL_OMIT_KEYS[tool] ?? []
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const camel = snakeToCamel(key)
    if (omit.includes(camel)) continue
    result[camel] = value
  }
  return result
}

export function toolUseBlockToPart(
  block: BetaToolUseBlock,
  sessionID: SessionID,
  messageID: MessageID,
): MessageV2.ToolPart {
  const tool = normalizeTool(block.name)
  const input = normalizeInput(tool, (block.input ?? {}) as Record<string, unknown>)
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: block.id,
    tool,
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
