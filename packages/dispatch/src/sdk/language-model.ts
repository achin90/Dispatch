export * as SdkLanguageModel from "./language-model.js"

import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { APICallError } from "@ai-sdk/provider"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { SdkBin } from "./bin.js"
import { SdkEnv } from "./env.js"
import { SdkModels } from "./models.js"

/**
 * A single-shot language model backed by a one-turn, tool-free `query()`.
 *
 * Title generation, `generate` and summary compaction call `llm.stream` with a resolved model.
 * Anthropic models resolve here (through the Dispatch plugin's AI SDK hook) so those callers work
 * with a Claude subscription login and no API key.
 */
export function make(modelID: string, apiKey?: string): LanguageModelV3 {
  const stream = (options: LanguageModelV3CallOptions): ReadableStream<LanguageModelV3StreamPart> => {
    const abortController = new AbortController()
    options.abortSignal?.addEventListener("abort", () => abortController.abort(), { once: true })
    const rendered = render(options.prompt)
    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        const id = "text-0"
        let started = false
        let result: SDKResultMessage | undefined
        try {
          const bin = await SdkBin.resolveClaudeBin()
          const messages = query({
            prompt: rendered.prompt,
            options: {
              model: SdkModels.cliModel(modelID),
              systemPrompt: rendered.system,
              env: SdkEnv.build({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY }),
              maxTurns: 1,
              tools: [],
              strictMcpConfig: true,
              // Isolation: no filesystem settings, hooks or CLAUDE.md for an auxiliary request.
              settingSources: [],
              persistSession: false,
              includePartialMessages: true,
              abortController,
              canUseTool: async () => ({ behavior: "deny", message: "Tools are disabled" }),
              ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
            },
          })
          for await (const message of messages as AsyncIterable<SDKMessage>) {
            const delta = textDelta(message)
            if (delta) {
              if (!started) controller.enqueue({ type: "text-start", id })
              started = true
              controller.enqueue({ type: "text-delta", id, delta })
            }
            if (message.type === "result") result = message
          }
        } catch (error) {
          controller.enqueue({ type: "error", error: apiError(error) })
        }
        if (!started && result?.subtype === "success" && result.result) {
          controller.enqueue({ type: "text-start", id })
          controller.enqueue({ type: "text-delta", id, delta: result.result })
          started = true
        }
        if (started) controller.enqueue({ type: "text-end", id })
        if (result?.is_error)
          controller.enqueue({
            type: "error",
            error: apiError(
              new Error("errors" in result ? result.errors.join("; ") : "The Claude Agent SDK reported an error"),
            ),
          })
        controller.enqueue({ type: "finish", finishReason: finish(result), usage: usage(result) })
        controller.close()
      },
      cancel() {
        abortController.abort()
      },
    })
  }

  return {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId: modelID,
    supportedUrls: {},
    doStream: async (options) => ({ stream: stream(options) }),
    doGenerate: async (options) => {
      const reader = stream(options).getReader()
      const parts: LanguageModelV3StreamPart[] = []
      while (true) {
        const next = await reader.read()
        if (next.done) break
        parts.push(next.value)
      }
      const error = parts.find((part) => part.type === "error")
      if (error) throw error.error
      const done = parts.find((part) => part.type === "finish")
      return {
        content: [
          {
            type: "text",
            text: parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join(""),
          },
        ],
        finishReason: done?.finishReason ?? finish(undefined),
        usage: done?.usage ?? usage(undefined),
        warnings: [],
      }
    },
  }
}

/** System messages become the system prompt; the rest a plain transcript ending in the request. */
export function render(prompt: LanguageModelV3Prompt) {
  const system = prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n\n")
  const turns = prompt.flatMap((message) => {
    if (message.role === "system") return []
    const text = message.content
      .flatMap((part) => (part.type === "text" || part.type === "reasoning" ? [part.text] : []))
      .join("\n")
    if (!text) return []
    return [{ role: message.role, text }]
  })
  const only = turns.length === 1 && turns[0].role === "user"
  return {
    system,
    prompt: only
      ? turns[0].text
      : turns.map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`).join("\n\n"),
  }
}

/**
 * The CLI reports API failures as plain text ("API Error: 400 …"). Carrying the status lets core classify them:
 * a 400 such as the third-party-app billing rejection fails at once instead of being retried for ~100s, while
 * 429 and 5xx keep retrying. Errors without a status pass through unchanged.
 */
export function apiError(error: unknown) {
  if (!(error instanceof Error)) return error
  const status = /API Error: (\d{3})\b/.exec(error.message)?.[1]
  if (!status) return error
  const statusCode = Number(status)
  return new APICallError({
    message: error.message,
    url: "claude-agent-sdk",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
    cause: error,
  })
}

function textDelta(message: SDKMessage) {
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return undefined
  const event = message.event
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") return undefined
  return event.delta.text
}

function finish(result: SDKResultMessage | undefined): LanguageModelV3FinishReason {
  if (!result) return { unified: "other", raw: undefined }
  if (result.is_error) return { unified: "error", raw: result.subtype }
  if (result.stop_reason === "max_tokens") return { unified: "length", raw: result.stop_reason }
  return { unified: "stop", raw: result.stop_reason ?? undefined }
}

function usage(result: SDKResultMessage | undefined): LanguageModelV3Usage {
  const value = result?.usage
  const input = value?.input_tokens ?? 0
  const read = value?.cache_read_input_tokens ?? 0
  const write = value?.cache_creation_input_tokens ?? 0
  return {
    inputTokens: { total: input + read + write, noCache: input, cacheRead: read, cacheWrite: write },
    outputTokens: { total: value?.output_tokens, text: value?.output_tokens, reasoning: undefined },
  }
}
