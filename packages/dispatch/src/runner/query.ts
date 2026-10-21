export * as SdkQuery from "./query.js"

import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { SessionMessage } from "@opencode/core/session/message"
import { SdkEnv } from "../sdk/env.js"

type MessageParam = SDKUserMessage["message"]
type UserContent = Exclude<MessageParam["content"], string>

type Image = "image/png" | "image/jpeg" | "image/gif" | "image/webp"
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Session messages the next SDK turn answers: everything after the last reply or compaction. */
export function pending(messages: ReadonlyArray<SessionMessage.Info>) {
  const last = messages.findLastIndex((message) => message.type === "assistant" || message.type === "compaction")
  return messages.slice(last + 1).filter((message) => message.type === "user" || message.type === "synthetic")
}

/** The user turn: plain text, or a Messages API user message when it carries images or PDFs. */
export function prompt(messages: ReadonlyArray<SessionMessage.Info>): string | MessageParam {
  const text = messages
    .flatMap((message) => (message.type === "user" || message.type === "synthetic" ? [message.text] : []))
    .filter((value) => value.trim().length > 0)
  const files = messages.flatMap((message) => (message.type === "user" ? (message.files ?? []) : []))
  const media = files.flatMap((file): UserContent => {
    if (file.mime === "application/pdf")
      return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }]
    if (!IMAGES.has(file.mime)) return []
    return [{ type: "image", source: { type: "base64", media_type: file.mime as Image, data: file.data } }]
  })
  // Materialized text attachments carry their contents; anything else is named so the model can read it.
  const inline = files.flatMap((file) => {
    if (file.mime === "application/pdf" || IMAGES.has(file.mime)) return []
    const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")
    if (!file.mime.startsWith("text/") && file.mime !== "application/json") return [`Attached file: ${name}`]
    return [`<file name="${name}">\n${Buffer.from(file.data, "base64").toString("utf8")}\n</file>`]
  })
  const body = [...text, ...inline].join("\n\n")
  if (media.length === 0) return body
  return { role: "user", content: [...media, ...(body ? [{ type: "text" as const, text: body }] : [])] }
}

export interface OptionsInput {
  readonly model: string
  readonly systemPrompt: string
  readonly cwd: string
  readonly resume?: string
  readonly apiKey?: string
  readonly effort?: string
  readonly contextWindow: number
  readonly advisorModel?: string
  readonly abortController: AbortController
  readonly canUseTool: CanUseTool
  readonly preToolUse: HookCallback
  readonly postCompact: HookCallback
  readonly mcpServers: Record<string, McpServerConfig>
  readonly pathToClaudeCodeExecutable?: string
  readonly maxTurns?: number
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

/** `query()` options for one Session turn. */
export function options(input: OptionsInput): Options {
  return {
    model: input.model,
    systemPrompt: input.systemPrompt,
    cwd: input.cwd,
    env: SdkEnv.build({ apiKey: input.apiKey }),
    // "default" keeps canUseTool in charge; bypassPermissions would shadow it.
    permissionMode: "default",
    canUseTool: input.canUseTool,
    abortController: input.abortController,
    includePartialMessages: true,
    ...(input.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.effort && EFFORTS.has(input.effort) ? { effort: input.effort as Options["effort"] } : {}),
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
    mcpServers: input.mcpServers,
    // MCP servers come only from opencode. Otherwise the CLI also loads .mcp.json, ~/.claude.json and
    // claude.ai connectors, whose unauthenticated servers inject reminders the model reports to the user.
    strictMcpConfig: true,
    hooks: {
      PreToolUse: [{ hooks: [input.preToolUse] }],
      PostCompact: [{ hooks: [input.postCompact] }],
    },
    settings: {
      // The CLI settings schema accepts 1e5..1e6 and silently drops anything else.
      autoCompactWindow: Math.min(Math.max(input.contextWindow, 100_000), 1_000_000),
      ...(input.advisorModel ? { advisorModel: input.advisorModel } : {}),
    },
  }
}

/** The prompt argument for `query()`. */
export function input(value: string | MessageParam): string | AsyncIterable<SDKUserMessage> {
  if (typeof value === "string") return value
  return (async function* () {
    yield { type: "user", message: value, parent_tool_use_id: null } satisfies SDKUserMessage
  })()
}

/** A resume the CLI cannot find; the mapping is stale and the turn retries without it. */
export const isStaleResume = (message: string) => message.includes("No conversation found")
