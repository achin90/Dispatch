/**
 * Wrapper around the Claude Agent SDK's query() function that:
 * 1. Resolves the Anthropic API key from the existing auth system or env
 * 2. Sets up the canUseTool permission bridge
 * 3. Resumes previous SDK sessions for conversation continuity
 * 4. Calls query() with proper options
 * 5. Returns the message stream for processClaudeSdkStream()
 */

import { query, type Options, type Query, type SDKUserMessage, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ListToolsRequestSchema, CallToolRequestSchema, type ServerResult } from "@modelcontextprotocol/sdk/types.js"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { createCanUseToolBridge } from "./claude-sdk-permissions"
import { getSdkSessionID } from "./claude-sdk-session-map"

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
}

/**
 * Creates in-process SDK MCP servers that proxy tool calls to
 * OpenCode's already-connected MCP clients. Uses raw request handlers
 * so the original JSON schemas are preserved for the model.
 */
export async function resolveMcpServers(): Promise<Record<string, McpServerConfig> | undefined> {
  const connected = await MCP.clients()
  const names = Object.keys(connected)
  if (!names.length) {
    log.info("resolveMcpServers: no connected MCP clients")
    return undefined
  }

  log.info("resolveMcpServers: building SDK servers from connected clients", { names })

  const servers: Record<string, McpServerConfig> = {}

  for (const [name, client] of Object.entries(connected)) {
    const listed = await client.listTools().catch((err) => {
      log.error("resolveMcpServers: listTools failed", { name, error: err instanceof Error ? err.message : String(err) })
      return undefined
    })
    if (!listed || !listed.tools.length) continue

    // Create an in-process MCP server that proxies to the OpenCode client.
    // Must declare tools capability so setRequestHandler accepts tools/list.
    const proxy = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } })

    // Override the low-level request handlers to proxy with original schemas
    proxy.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listed.tools,
    }))

    proxy.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const result = await client.callTool({
        name: req.params.name,
        arguments: req.params.arguments ?? {},
      })
      return result as ServerResult
    })

    servers[name] = { type: "sdk" as const, name, instance: proxy }
    log.info("resolveMcpServers: created proxy server", { name, tools: listed.tools.length })
  }

  return Object.keys(servers).length ? servers : undefined
}

/**
 * Resolves the Anthropic API key from:
 * 1. ANTHROPIC_API_KEY environment variable (already set)
 * 2. The Auth store (auth.json) for the "anthropic" provider
 *
 * Returns undefined if no key is found — the Agent SDK will try
 * OAuth/subscription login in that case.
 */
export async function resolveApiKey(): Promise<string | undefined> {
  // Check env first
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY
  }

  // Check auth store
  const authInfo = await Auth.get("anthropic")
  if (authInfo?.type === "api") {
    return authInfo.key
  }

  // No API key found — the Agent SDK will attempt OAuth/subscription
  return undefined
}

/**
 * Creates a Claude Agent SDK query() call wired with:
 * - API key from the existing auth system
 * - Permission bridge to the TUI
 * - Model and system prompt configuration
 * - Session resumption for conversation continuity
 */
export async function createClaudeSdkQuery(
  input: ClaudeSdkQueryInput,
): Promise<Query> {
  const apiKey = await resolveApiKey()

  const env: Record<string, string | undefined> = {
    ...process.env,
  }
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey
  }

  // Check if we have a previous SDK session UUID for this opencode session.
  // If so, resume it so the SDK loads the full conversation history from disk.
  const sdkSessionID = await getSdkSessionID(input.sessionID)

  const options: Options = {
    model: input.model,
    systemPrompt: input.systemPrompt,
    cwd: input.cwd ?? process.cwd(),
    env,
    betas: ["context-1m-2025-08-07"],
    permissionMode: input.permissionMode ?? "default",
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    canUseTool: createCanUseToolBridge({ sessionID: input.sessionID, messageID: input.messageID, ruleset: input.ruleset }),
    abortController: input.abortController,
    maxTurns: input.maxTurns,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(sdkSessionID ? { resume: sdkSessionID } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
  }

  log.info("createClaudeSdkQuery: options built", {
    hasMcpServers: !!options.mcpServers,
    mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : [],
    model: options.model,
    hasResume: !!sdkSessionID,
  })

  // When prompt contains image/media content blocks, wrap it as an
  // SDKUserMessage so the SDK receives the full MessageParam with images.
  // Plain strings are passed through directly.
  const prompt: string | AsyncIterable<SDKUserMessage> =
    typeof input.prompt === "string"
      ? input.prompt
      : (async function* () {
          yield {
            type: "user" as const,
            message: input.prompt as MessageParam,
            parent_tool_use_id: null,
            session_id: sdkSessionID ?? "",
          }
        })()

  return query({
    prompt,
    options,
  })
}
