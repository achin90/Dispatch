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
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ServerResult,
  type ListToolsRequest,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js"
import { withTimeout } from "@/util/timeout"
import type { Hooks } from "@opencode-ai/plugin"
import z from "zod"

// Derive MessageParam from SDKUserMessage to avoid importing from
// @anthropic-ai/sdk which is only a transitive dep.
type MessageParam = SDKUserMessage["message"]
import { Effect } from "effect"
import { Auth } from "@/auth"
import * as LogBridge from "@/util/log-bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { AppRuntime } from "@/effect/app-runtime"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID, MessageID } from "@/session/schema"
import { createCanUseToolBridge, createSubagentPermissionHook } from "./claude-sdk-permissions"
import { getSdkSessionEntry, removeSdkSessionID } from "./claude-sdk-session-map"
import bin from "./claude-sdk-bin"

const log = LogBridge.create({ service: "claude-sdk-query" })

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
  ruleset?: PermissionV1.Ruleset
  effort?: Options["effort"]
  mcpServers?: Record<string, McpServerConfig>
  hooks?: Options["hooks"]
  contextWindow?: number
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

function invalidateMcpCache() {
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
    await AppRuntime.runPromise(
      EventV2Bridge.Service.use((events) =>
        events.listen((event) => {
          if (event.type !== MCP.ToolsChanged.type) return Effect.void
          log.info("mcp tools changed, invalidating cache")
          invalidateMcpCache()
          return Effect.void
        }),
      ),
    )
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
 * Creates an in-process MCP server that exposes plugin tools (from hooks.tool)
 * to the Claude Agent SDK. Plugin tools come from loaded plugins like
 * opencode-scheduler and never flow through the MCP.Service clients path,
 * so they would otherwise be invisible to the SDK.
 *
 * Returns undefined if no plugin tools are registered.
 */
export const PLUGIN_TOOL_SERVER_NAME = "opencode-plugins"

export function createPluginToolMcpServer(
  hooks: Hooks[],
  cwd: string,
  worktree: string,
): McpServerConfig | undefined {
  const toolMap = Object.fromEntries(
    hooks.flatMap((hook) => Object.entries(hook.tool ?? {})),
  ) as Record<
    string,
    { description: string; args: Record<string, z.ZodTypeAny>; execute: (args: unknown, ctx: unknown) => Promise<unknown> }
  >

  const toolNames = Object.keys(toolMap)
  log.info("createPluginToolMcpServer: plugin tools found", { count: toolNames.length, names: toolNames })

  if (!toolNames.length) {
    log.info("createPluginToolMcpServer: no plugin tools registered, skipping")
    return undefined
  }

  const tools: ToolDefs = toolNames.map((name) => ({
    name,
    description: toolMap[name].description,
    inputSchema: z.toJSONSchema(z.object(toolMap[name].args), { io: "input" }) as Record<string, unknown>,
  }))

  log.info("createPluginToolMcpServer: registering tools in proxy MCP server", { tools: tools.map((t) => t.name) })

  const config = createSdkMcpServer({
    name: PLUGIN_TOOL_SERVER_NAME,
    tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
  })

  config.instance.server.setRequestHandler(ListToolsRequestSchema, async (_req: ListToolsRequest) => {
    log.info("createPluginToolMcpServer: listTools called", { tools: tools.map((t) => t.name) })
    return { tools }
  })

  config.instance.server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest): Promise<ServerResult> => {
    const name = req.params.name
    const def = toolMap[name]
    if (!def) {
      log.error("createPluginToolMcpServer: callTool for unknown tool", { name })
      return { content: [{ type: "text", text: `Plugin tool "${name}" not found` }], isError: true }
    }
    log.info("createPluginToolMcpServer: executing plugin tool", { name })
    // Most plugin tools (e.g. opencode-scheduler) don't use the context — they
    // rely on args or process.cwd(). Provide a minimal stub so the type contract
    // is satisfied and directory-aware tools get a useful value.
    const executeResult = await def.execute(req.params.arguments ?? {}, {
      sessionID: "",
      messageID: "",
      agent: "",
      directory: cwd,
      worktree,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => Effect.void,
    }).catch((err: unknown) => {
      log.error("createPluginToolMcpServer: plugin tool execution failed", {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
      return err instanceof Error ? err.message : String(err)
    })
    const output = typeof executeResult === "string" ? executeResult : (executeResult as { output: string }).output ?? ""
    log.info("createPluginToolMcpServer: plugin tool executed successfully", { name })
    return { content: [{ type: "text", text: output }] }
  })

  return config
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
    // The CLI only enables native-1M context (e.g. Sonnet 5) when it believes
    // it's talking to first-party Anthropic: its Yd() gate requires
    // ANTHROPIC_BASE_URL to be unset or api.anthropic.com. When a local proxy
    // (e.g. sleeve) sets ANTHROPIC_BASE_URL, that gate fails, the model window
    // falls back to 200k, and auto-compact fires at 200k regardless of the
    // autoCompactWindow setting. This escape hatch asserts first-party
    // semantics; the claudesdk path always authenticates against Anthropic.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
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
    // canUseTool handles the main thread (permission prompts, edit diffs,
    // AskUserQuestion / ExitPlanMode routing). It is NOT invoked for headless
    // subagents, so a PreToolUse hook propagates the same ruleset to subagent
    // tool calls — see createSubagentPermissionHook. Staying on "default" keeps
    // the canUseTool bridge alive (bypassPermissions would shadow it entirely).
    const subagentPermissionHook = createSubagentPermissionHook(input.ruleset ?? [])
    return {
      model: input.model,
      systemPrompt: input.systemPrompt,
      cwd,
      env,
      permissionMode: input.permissionMode ?? "default",
      ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
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
      // MCP servers come exclusively from opencode's own config (proxied via
      // resolveMcpServers). Without this, the spawned CLI ALSO loads its own
      // MCP sources — project .mcp.json, ~/.claude.json / user settings,
      // plugins, claude.ai connectors — and unauthenticated ones (e.g. the
      // claude.ai Slack/Notion/Calendar connectors) inject "requires
      // authentication" reminders that the model then reports to the user.
      strictMcpConfig: true,
      hooks: {
        ...(input.hooks ?? {}),
        PreToolUse: [...(input.hooks?.PreToolUse ?? []), { hooks: [subagentPermissionHook] }],
      },
      // Clamp to the CLI settings schema range (1e5..1e6) — out-of-range
      // values are silently dropped by its zod .catch(undefined).
      ...(input.contextWindow
        ? { settings: { autoCompactWindow: Math.min(Math.max(input.contextWindow, 100_000), 1_000_000) } }
        : {}),
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
