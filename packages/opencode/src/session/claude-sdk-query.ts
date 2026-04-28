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
import { withTimeout } from "@/util/timeout"

// Derive MessageParam from SDKUserMessage to avoid importing from
// @anthropic-ai/sdk which is only a transitive dep.
type MessageParam = SDKUserMessage["message"]
import { Effect } from "effect"
import { Auth } from "@/auth"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { MCP } from "@/mcp"
import { AppRuntime } from "@/effect/app-runtime"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { createCanUseToolBridge } from "./claude-sdk-permissions"
import { getSdkSessionEntry, removeSdkSessionID } from "./claude-sdk-session-map"
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
 * Creates in-process SDK MCP servers that proxy tool calls to
 * OpenCode's already-connected MCP clients. Uses raw request handlers
 * so the original JSON schemas are preserved for the model.
 *
 * Results are cached globally and invalidated when MCP tools change
 * or servers connect/disconnect.
 */
// Cache tool DEFINITIONS (not proxy server objects). Each resolveMcpServers()
// call creates fresh proxy instances from the cached defs because MCP is
// point-to-point — sharing a proxy between SDK sessions causes the second
// session to disconnect the first.
type ToolDefs = Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
let cachedDefs: Record<string, ToolDefs> | undefined
let dirty = true
let flight: Promise<Record<string, ToolDefs> | undefined> | undefined
let subscribed = false

export function invalidateMcpCache() {
  dirty = true
  // Do NOT clear cachedDefs here. resolveDefs() uses the previous value as a
  // fallback for servers whose listTools() call fails (e.g. a server that is
  // in the reconnect backoff window). Clearing it would cause those servers to
  // disappear from the agent's tool set until the reconnect completes.
}

function createProxy(name: string, tools: ToolDefs): McpServerConfig {
  const config = createSdkMcpServer({
    name,
    tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
  })

  config.instance.server.setRequestHandler(ListToolsRequestSchema as any, async () => ({
    tools,
  }))

  config.instance.server.setRequestHandler(CallToolRequestSchema as any, async (req: any) => {
    const currentClient = await AppRuntime.runPromise(
      MCP.Service.use((svc) =>
        Effect.gen(function* () {
          if ((yield* svc.status())[name]?.status !== "connected") return undefined
          return (yield* svc.clients())[name]
        }),
      ),
    )
    if (!currentClient) throw new Error(`MCP server "${name}" is not connected`)
    return (await currentClient.callTool({
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    })) as ServerResult
  })

  return config
}

async function resolveDefs(): Promise<Record<string, ToolDefs> | undefined> {
  const connected = await AppRuntime.runPromise(MCP.Service.use((svc) => svc.clients()))
  if (!Object.keys(connected).length) return undefined

  const defs: Record<string, ToolDefs> = {}
  for (const entry of await Promise.all(
    Object.entries(connected).map(async ([name, client]) => {
      const listed = await withTimeout(client.listTools(), 30_000).catch((err) => {
        log.error("resolveMcpServers: listTools failed", {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      })
      if (!listed) {
        const fallback = cachedDefs?.[name]
        return fallback !== undefined ? ([name, fallback] as const) : undefined
      }
      if (!listed.tools.length) return undefined
      return [name, listed.tools as ToolDefs] as const
    }),
  )) {
    if (entry) defs[entry[0]] = entry[1]
  }

  return Object.keys(defs).length ? defs : undefined
}

export async function resolveMcpServers(): Promise<Record<string, McpServerConfig> | undefined> {
  if (!subscribed) {
    subscribed = true
    Bus.subscribe(MCP.ToolsChanged, () => {
      log.info("mcp tools changed, invalidating cache")
      invalidateMcpCache()
    })
  }

  if (dirty) {
    if (!flight) {
      flight = resolveDefs().finally(() => {
        flight = undefined
      })
    }
    const result = await flight
    // If ToolsChanged fired mid-flight, stay dirty so the next call re-resolves.
    if (dirty) {
      cachedDefs = result
      dirty = false
    }
  }

  if (!cachedDefs) return undefined

  // Always create fresh proxy instances — MCP is point-to-point, so sharing
  // a proxy between SDK sessions causes the second to disconnect the first.
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, tools] of Object.entries(cachedDefs)) {
    servers[name] = createProxy(name, tools)
  }
  return servers
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
  const authInfo = await AppRuntime.runPromise(Auth.Service.use((svc) => svc.get("anthropic")))
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

  // Check if we have a previous SDK session entry for this opencode session.
  // If so, resume it with the *original* cwd so the SDK finds its session files
  // and loads full conversation history, even if the opencode session has since
  // been moved to a different directory.
  const entry = await getSdkSessionEntry(input.sessionID)
  const currentCwd = input.cwd ?? process.cwd()
  log.info("createClaudeSdkQuery: resume lookup", {
    sessionID: input.sessionID,
    sdkSessionID: entry?.uuid ?? "(none)",
    storedCwd: entry?.cwd ?? "(none)",
    currentCwd,
  })

  function buildOptions(resume: string | undefined, cwd: string): Options {
    return {
      model: input.model,
      systemPrompt: input.systemPrompt,
      cwd,
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
      ...(resume ? { resume } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.hooks ? { hooks: input.hooks } : {}),
    }
  }

  // When resuming, use the original cwd so the SDK finds its session files.
  // For new sessions (no entry), use the current directory.
  const resumeCwd = entry?.cwd || currentCwd
  const options = buildOptions(entry?.uuid, entry ? resumeCwd : currentCwd)

  log.info("createClaudeSdkQuery: options built", {
    hasMcpServers: !!options.mcpServers,
    mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : [],
    model: options.model,
    hasResume: !!entry?.uuid,
    cwd: options.cwd,
  })

  // When prompt contains image/media content blocks, wrap it as an
  // SDKUserMessage so the SDK receives the full MessageParam with images.
  // Plain strings are passed through directly.
  function buildPrompt(resume: string | undefined): string | AsyncIterable<SDKUserMessage> {
    if (typeof input.prompt === "string") return input.prompt
    return (async function* () {
      yield {
        type: "user" as const,
        message: input.prompt as MessageParam,
        parent_tool_use_id: null,
        session_id: resume ?? "",
      }
    })()
  }

  try {
    return await query({ prompt: buildPrompt(entry?.uuid), options })
  } catch (err) {
    // If the SDK still can't find the session (e.g. files deleted, corrupted),
    // clear the stale entry and retry without resume.
    const msg = err instanceof Error ? err.message : String(err)
    if (entry?.uuid && msg.includes("No conversation found")) {
      log.info("createClaudeSdkQuery: stale SDK session, clearing and retrying without resume", {
        sessionID: input.sessionID,
        staleSdkSessionID: entry.uuid,
        error: msg,
      })
      await removeSdkSessionID(input.sessionID)
      return query({ prompt: buildPrompt(undefined), options: buildOptions(undefined, currentCwd) })
    }
    throw err
  }
}
