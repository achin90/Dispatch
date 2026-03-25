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
} from "@anthropic-ai/claude-agent-sdk"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import {
  assistantMessageToParts,
  resultMessageToMetadata,
  type CompletionMetadata,
} from "./claude-sdk-adapter"

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
 */
export async function processClaudeSdkStream(
  messages: AsyncIterable<SDKMessage>,
  input: ClaudeSdkProcessorInput,
): Promise<ClaudeSdkProcessorResult> {
  const { assistantMessage, sessionID } = input
  let completionMeta: CompletionMetadata | undefined

  for await (const msg of messages) {
    if (input.abort.aborted) break

    switch (msg.type) {
      case "assistant":
        await processAssistantMessage(
          msg as SDKAssistantMessage,
          sessionID,
          assistantMessage.id,
        )
        break

      case "result":
        completionMeta = processResultMessage(
          msg as SDKResultMessage,
          assistantMessage,
        )
        await Session.updateMessage(assistantMessage)
        break

      // system, user, stream_event, etc. — ignored
      default:
        break
    }
  }

  // If we exited without a result message (e.g. abort), mark as error
  if (!completionMeta) {
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
 * Maps an SDKAssistantMessage's content blocks to MessageV2 parts and persists each one.
 */
async function processAssistantMessage(
  msg: SDKAssistantMessage,
  sessionID: SessionID,
  messageID: MessageID,
): Promise<void> {
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
