/**
 * Wrapper around the Claude Agent SDK's query() function that:
 * 1. Resolves the Anthropic API key from the existing auth system or env
 * 2. Sets up the canUseTool permission bridge
 * 3. Resumes previous SDK sessions for conversation continuity
 * 4. Calls query() with proper options
 * 5. Returns the message stream for processClaudeSdkStream()
 */

import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk"
// MessageParam from the Anthropic SDK — define locally to avoid direct dependency
interface MessageParam {
  role: "user" | "assistant"
  content: string | Array<Record<string, unknown>>
}
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { createCanUseToolBridge } from "./claude-sdk-permissions"
import { getSdkSessionID } from "./claude-sdk-session-map"
import bin from "@anthropic-ai/claude-agent-sdk/embed"

const log = Log.create({ service: "claude-sdk-query" })

export interface ClaudeSdkQueryInput {
  prompt: string | MessageParam
  sessionID: SessionID
  messageID: MessageID
  model?: string
  systemPrompt?: string
  cwd?: string
  permissionMode?: Options["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  abortController?: AbortController
  maxTurns?: number
  ruleset?: Permission.Ruleset
  effort?: Options["effort"]
  mcpServers?: Record<string, McpServerConfig>
  hooks?: Options["hooks"]
}

/**
 * Resolves the Anthropic API key from env or Auth store.
 */
export async function resolveApiKey(): Promise<string | undefined> {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY
  }

  const authInfo = await Auth.get("anthropic")
  if (authInfo?.type === "api") {
    return authInfo.key
  }

  return undefined
}

/**
 * Creates a Claude Agent SDK query() call wired with auth, permissions, etc.
 */
export async function createClaudeSdkQuery(input: ClaudeSdkQueryInput): Promise<Query> {
  const apiKey = await resolveApiKey()

  const env: Record<string, string | undefined> = {
    ...process.env,
  }
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey
  }

  const sdkSessionID = await getSdkSessionID(input.sessionID)

  const options: Options = {
    model: input.model,
    systemPrompt: input.systemPrompt,
    cwd: input.cwd ?? process.cwd(),
    env,
    betas: ["context-1m-2025-08-07"],
    permissionMode: input.permissionMode ?? "default",
    pathToClaudeCodeExecutable: bin,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    canUseTool: createCanUseToolBridge({
      sessionID: input.sessionID,
      messageID: input.messageID,
      ruleset: input.ruleset,
    }),
    abortController: input.abortController,
    maxTurns: input.maxTurns,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(sdkSessionID ? { resume: sdkSessionID } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
  }

  log.info("createClaudeSdkQuery: options built", {
    hasMcpServers: !!options.mcpServers,
    mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : [],
    model: options.model,
    hasResume: !!sdkSessionID,
  })

  const prompt: string | AsyncIterable<SDKUserMessage> =
    typeof input.prompt === "string"
      ? input.prompt
      : (async function* () {
          yield {
            type: "user" as const,
            message: input.prompt,
            parent_tool_use_id: null,
            session_id: sdkSessionID ?? "",
          } as SDKUserMessage
        })()

  return query({
    prompt,
    options,
  })
}
