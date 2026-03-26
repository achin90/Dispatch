/**
 * Processor that consumes the Claude Agent SDK's query() output (async generator of SDKMessage)
 * and maps it into MessageV2 parts persisted via Session.updatePart/updateMessage.
 *
 * This replaces the existing SessionProcessor.process() + LLM.stream() path
 * when using the Claude Agent SDK instead of the Vercel AI SDK.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import {
  assistantMessageToParts,
  resultMessageToMetadata,
  type CompletionMetadata,
} from "./claude-sdk-adapter"
import { setSdkSessionID } from "./claude-sdk-session-map"

export interface ClaudeSdkProcessorInput {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  abort: AbortSignal
}

export interface ClaudeSdkProcessorResult {
  outcome: "stop" | "error"
  metadata?: CompletionMetadata
}

/**
 * Process a stream of SDKMessage from the Agent SDK's query() function.
 *
 * For each AssistantMessage: maps content blocks to MessageV2 parts and persists them.
 * For the ResultMessage: finalizes the assistant message with cost/token metadata.
 * Ignores system messages, user messages, and other SDK-internal message types.
 *
 * The SDK owns tool execution — it never sends us tool-result events. Before
 * processing a new assistant message (which means previous tools finished),
 * we finalize any "running" tool parts so spinners stop and the TUI can
 * collapse them.
 */
export async function processClaudeSdkStream(
  messages: AsyncIterable<SDKMessage>,
  input: ClaudeSdkProcessorInput,
): Promise<ClaudeSdkProcessorResult> {
  const { assistantMessage, sessionID } = input
  let completionMeta: CompletionMetadata | undefined

  try {
    for await (const msg of messages) {
      if (input.abort.aborted) break

      switch (msg.type) {
        case "assistant":
          // The SDK wouldn't send a new assistant message if previous tools
          // were still running — finalize any "running" parts first.
          await finalizeRunningTools(assistantMessage.id)
          await processAssistantMessage(
            msg as SDKAssistantMessage,
            sessionID,
            assistantMessage.id,
          )
          break

        case "result":
          // All tools must be complete before the result — finalize stragglers.
          await finalizeRunningTools(assistantMessage.id)
          completionMeta = processResultMessage(
            msg as SDKResultMessage,
            assistantMessage,
          )
          await Session.updateMessage(assistantMessage)
          break

        case "system":
          // Capture the SDK-assigned session UUID so we can resume this session later.
          // The SDK generates the UUID on first query; we persist the mapping.
          await setSdkSessionID(sessionID, (msg as SDKSystemMessage).session_id)
          break

        // user, stream_event, etc. — ignored
        default:
          break
      }
    }
  } catch (error) {
    // The SDK throws when the abort signal fires (e.g. user presses Esc).
    // This is expected — treat it as a clean abort, not an unhandled error.
    if (input.abort.aborted) {
      // Fall through to the abort handling below
    } else {
      throw error
    }
  }

  // If we exited without a result message (e.g. abort), mark pending tools as errors
  if (!completionMeta) {
    await abortRunningTools(assistantMessage.id)
    assistantMessage.time.completed = Date.now()
    assistantMessage.error = {
      name: "MessageAbortedError",
      data: { message: "Stream ended without result" },
    } as MessageV2.Assistant["error"]
    await Session.updateMessage(assistantMessage)
    return { outcome: "error" }
  }

  return {
    outcome: completionMeta.success ? "stop" : "error",
    metadata: completionMeta,
  }
}

/**
 * Mark all "running" tool parts as "completed". Called before processing a new
 * assistant message or result, since the SDK wouldn't proceed if tools were
 * still running.
 */
async function finalizeRunningTools(messageID: MessageID): Promise<void> {
  const parts = await MessageV2.parts(messageID)
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "running") continue
    await Session.updatePart({
      ...part,
      state: {
        status: "completed",
        input: part.state.input,
        output: "",
        title: part.state.title ?? "",
        metadata: part.state.metadata ?? {},
        time: {
          start: part.state.time.start,
          end: Date.now(),
        },
      },
    })
  }
}

/**
 * Mark all "running" tool parts as "error" on abort/unexpected exit.
 */
async function abortRunningTools(messageID: MessageID): Promise<void> {
  const parts = await MessageV2.parts(messageID)
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "running") continue
    await Session.updatePart({
      ...part,
      state: {
        status: "error",
        input: part.state.input,
        error: "Tool execution aborted",
        time: {
          start: part.state.time.start,
          end: Date.now(),
        },
      },
    })
  }
}

/**
 * Maps an SDKAssistantMessage's content blocks to MessageV2 parts and persists each one.
 * Skips subagent messages (parent_tool_use_id !== null) — those belong to child sessions
 * and should not appear in the main conversation.
 */
async function processAssistantMessage(
  msg: SDKAssistantMessage,
  sessionID: SessionID,
  messageID: MessageID,
): Promise<void> {
  if (msg.parent_tool_use_id !== null) return
  const parts = assistantMessageToParts(msg, sessionID, messageID)
  for (const part of parts) {
    await Session.updatePart(part)
  }
}

/**
 * Extracts completion metadata from SDKResultMessage and updates the assistant message.
 * Mutates the assistantMessage in place (same pattern as existing processor).
 */
function processResultMessage(
  msg: SDKResultMessage,
  assistantMessage: MessageV2.Assistant,
): CompletionMetadata {
  const meta = resultMessageToMetadata(msg)

  assistantMessage.time.completed = Date.now()
  assistantMessage.cost = meta.total_cost_usd
  assistantMessage.tokens = {
    input: meta.tokens.input,
    output: meta.tokens.output,
    reasoning: 0,
    cache: {
      read: meta.tokens.cache_read,
      write: meta.tokens.cache_write,
    },
  }

  if (!meta.success) {
    assistantMessage.error = {
      name: "APIError",
      data: {
        message: meta.errors?.join("; ") ?? "Unknown error",
        isRetryable: false,
      },
    } as MessageV2.Assistant["error"]
  }

  assistantMessage.finish = meta.stop_reason ?? "end_turn"

  return meta
}
