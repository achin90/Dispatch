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
  createSdkMcpServer,
  type Options,
  type Query,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk"
import { ListToolsRequestSchema, CallToolRequestSchema, type ServerResult } from "@modelcontextprotocol/sdk/types.js"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import { Bus } from "@/bus"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { createCanUseToolBridge } from "./claude-sdk-permissions"
import { getSdkSessionID } from "./claude-sdk-session-map"
import claudeCliPath from "@anthropic-ai/claude-agent-sdk/embed"

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
 * Creates in-process SDK MCP servers that proxy tool calls to
 * OpenCode's already-connected MCP clients. Uses raw request handlers
 * so the original JSON schemas are preserved for the model.
 *
 * Results are cached globally and invalidated when MCP tools change
 * or servers connect/disconnect.
 */
let cached: Record<string, McpServerConfig> | undefined
let dirty = true
let flight: Promise<Record<string, McpServerConfig> | undefined> | undefined
let subscribed = false

export function invalidateMcpCache() {
  dirty = true
  cached = undefined
}

async function resolve(): Promise<Record<string, McpServerConfig> | undefined> {
  const latency = Log.create({ service: "submit.latency" })
  const connected = await MCP.clients()
  latency.info("[3k.2] MCP.clients() done", { ts: Date.now(), count: Object.keys(connected).length })
  const names = Object.keys(connected)
  if (!names.length) {
    log.info("resolveMcpServers: no connected MCP clients")
    return undefined
  }

  log.info("resolveMcpServers: building SDK servers from connected clients", { names })

  const servers: Record<string, McpServerConfig> = {}
  for (const entry of await Promise.all(
    Object.entries(connected).map(async ([name, client]) => {
      latency.info("[3k.3] listTools start", { ts: Date.now(), name })
      const listed = await client.listTools().catch((err) => {
        log.error("resolveMcpServers: listTools failed", {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      })
      latency.info("[3k.4] listTools done", { ts: Date.now(), name, tools: listed?.tools?.length ?? 0 })
      if (!listed || !listed.tools.length) return undefined

      // Use createSdkMcpServer to get a correctly-typed McpServerConfig.
      // Register a dummy tool so the server has tool capability, then
      // override the request handlers to proxy to the real MCP client.
      const config = createSdkMcpServer({
        name,
        tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
      })

      config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: listed.tools,
      }))

      config.instance.server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const result = await client.callTool({
          name: req.params.name,
          arguments: req.params.arguments ?? {},
        })
        return result as ServerResult
      })

      log.info("resolveMcpServers: created proxy server", { name, tools: listed.tools.length })
      return [name, config] as const
    }),
  )) {
    if (entry) servers[entry[0]] = entry[1]
  }

  return Object.keys(servers).length ? servers : undefined
}

export async function resolveMcpServers(): Promise<Record<string, McpServerConfig> | undefined> {
  const latency = Log.create({ service: "submit.latency" })
  latency.info("[3k.1] resolveMcpServers entered", { ts: Date.now(), cached: !dirty })
  if (!subscribed) {
    subscribed = true
    Bus.subscribe(MCP.ToolsChanged, () => {
      log.info("mcp tools changed, invalidating cache")
      invalidateMcpCache()
    })
  }
  if (!dirty) return cached

  // Single-flight: concurrent callers share one in-flight resolution.
  // After it completes, re-check dirty in case ToolsChanged fired mid-flight.
  if (!flight) {
    flight = resolve().finally(() => {
      flight = undefined
    })
  }
  const result = await flight
  if (!dirty) return cached
  cached = result
  dirty = false
  latency.info("[3k.5] resolveMcpServers done", { ts: Date.now(), count: cached ? Object.keys(cached).length : 0 })
  return cached
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
export async function createClaudeSdkQuery(input: ClaudeSdkQueryInput): Promise<Query> {
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
    pathToClaudeCodeExecutable: claudeCliPath,
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
