export * as SdkMcp from "./mcp.js"

import { createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/core/agent"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { SessionMessage } from "@opencode/core/session/message"
import type { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { definition, effectiveName, execute } from "@opencode/core/tool/runtime"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schedule } from "effect"
import { SdkAdapter } from "../sdk/adapter.js"

type Definition = { name: string; description?: string; inputSchema: Record<string, unknown> }

export type Run = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => Promise<A>

export const PLUGIN_SERVER = SdkAdapter.PLUGIN_SERVER

/** Links a plugin tool call to the tool part the router published for it. */
export interface Calls {
  /** The assistant message that published the call, once the router has seen it. */
  readonly lookup: (toolUseID: string) => Promise<{ readonly messageID: string } | undefined>
  /** Live metadata for the running part, e.g. the subagent's child session. */
  readonly progress: (toolUseID: string, metadata: Tool.Metadata) => Effect.Effect<void>
  /** Metadata for the part's result, which MCP's text-only content would otherwise drop. */
  readonly metadata: Map<string, Tool.Metadata>
  /** Aborted when the drain is interrupted, so a running call (and a foreground child) stops too. */
  readonly signal: AbortSignal
  /** Called when the user declines without feedback, which ends the turn as interrupted. */
  readonly onDecline?: () => void
}

// v2 tools the CLI already has its own version of, plus host-owned namespaces. `subagent` is not
// one: the CLI's Agent/Task tools are disabled so subagents run as v2 child sessions with core jobs,
// which can be backgrounded (Ctrl+B) and outlive the parent's one-shot query.
const BUILTIN_TOOLS = new Set([
  "shell",
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "todowrite",
  "question",
  "skill",
])
const HOST_NAMESPACES = ["opencode", "browser"]

/**
 * Proxies the Location's connected MCP servers into a Claude Agent SDK query.
 *
 * Invariants carried from v1:
 * - every query gets fresh proxy server objects, because MCP is point-to-point and a proxy
 *   shared between two SDK sessions disconnects the first;
 * - tool definitions come from the last good listing, so a server that is reconnecting keeps
 *   its tools visible instead of vanishing from the agent's tool set;
 * - a call checks the server status first and fails with a clear message when it is down.
 * Raw request handlers keep the servers' original JSON schemas.
 */
export function make(mcp: Mcp.Interface, registry: Tool.Interface, agents: Agent.Interface) {
  const cache = new Map<string, Definition[]>()

  const servers = Effect.fn("SdkMcp.servers")(function* (run: Run) {
    // A query's MCP servers are fixed when it starts, unlike the stock runner which re-snapshots tools
    // every step, so give servers still connecting after Location boot a bounded moment to finish.
    yield* mcp.servers().pipe(
      Effect.repeat({
        until: (servers) => !servers.some((server) => server.status.status === "pending"),
        schedule: Schedule.spaced("200 millis"),
      }),
      Effect.timeoutOption("10 seconds"),
    )
    const listed = Map.groupBy(yield* mcp.tools(), (tool) => tool.server)
    for (const [server, tools] of listed)
      cache.set(
        server,
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        })),
      )
    // A reconnecting server keeps its cached tools; one the user disconnected (or config disables) does not.
    const known = new Set(
      (yield* mcp.servers()).filter((server) => server.status.status !== "disabled").map((server) => server.name),
    )
    return Object.fromEntries(
      Array.from(cache)
        .filter(([server, tools]) => known.has(server) && tools.length > 0)
        .map(([server, tools]) => [server, proxy(mcp, server, tools, run)] as const),
    ) satisfies Record<string, McpServerConfig>
  })

  /** Plugin tools (not builtins, not MCP-backed), executed through v2's tool runtime. */
  const plugins = Effect.fn("SdkMcp.plugins")(function* (
    run: Run,
    context: { readonly sessionID: SessionSchema.ID; readonly agent: Agent.ID },
    calls: Calls,
  ) {
    const mcpNamespaces = new Set((yield* mcp.servers()).map((server) => McpTool.namespace(server.name)))
    const tools = (yield* registry.list()).filter((tool) => {
      const namespace = tool.options?.namespace
      if (namespace === undefined) return !BUILTIN_TOOLS.has(tool.id)
      if (mcpNamespaces.has(namespace)) return false
      return !HOST_NAMESPACES.some((host) => namespace === host || namespace.startsWith(`${host}.`))
    })
    if (tools.length === 0) return {} as Record<string, McpServerConfig>
    const byName = new Map(tools.map((tool) => [effectiveName(tool), tool]))
    const subagents = yield* availableSubagents(agents, context.agent)
    const config = createSdkMcpServer({
      name: PLUGIN_SERVER,
      tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
    })
    config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => {
        const described = definition(tool)
        return {
          name: described.name,
          description:
            described.name === SubagentTool.name && subagents ? `${described.description}\n\n${subagents}` : described.description,
          inputSchema: described.inputSchema as Record<string, unknown> & { type: "object" },
        }
      }),
    }))
    config.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = byName.get(request.params.name)
      if (!tool)
        return {
          content: [{ type: "text" as const, text: `Plugin tool "${request.params.name}" not found` }],
          isError: true,
        }
      // The CLI stamps every MCP call with the tool_use id of the part the router published for it.
      const meta = request.params._meta?.["claudecode/toolUseId"]
      const toolUseID = typeof meta === "string" ? meta : undefined
      const source = toolUseID ? await calls.lookup(toolUseID) : undefined
      const exit = await run(
        execute(tool, request.params.arguments ?? {}, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: SessionMessage.ID.make(source?.messageID ?? SessionMessage.ID.create()),
          id: Tool.CallID.make(toolUseID ?? `plugin_${crypto.randomUUID()}`),
          progress: (metadata) => (toolUseID ? calls.progress(toolUseID, metadata) : Effect.void),
        }).pipe(Effect.exit),
        AbortSignal.any([calls.signal, extra.signal]),
      ).catch((error: unknown) => Exit.die(error))
      if (Exit.isSuccess(exit)) {
        if (toolUseID && exit.value.metadata) calls.metadata.set(toolUseID, exit.value.metadata)
        return {
          content: exit.value.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "text" as const, text: part.name ?? part.uri },
          ),
        }
      }
      return { content: [{ type: "text" as const, text: failure(exit.cause, calls.onDecline) }], isError: true }
    })
    return { [PLUGIN_SERVER]: config } satisfies Record<string, McpServerConfig>
  })

  return { servers, plugins }
}

/**
 * The "Available subagents" list v2's subagent tool adds to its description through the session
 * `context` hook, which the SDK runner never fires. Same filter: non-primary, visible, not denied.
 */
const availableSubagents = Effect.fnUntraced(function* (agents: Agent.Interface, agentID: Agent.ID) {
  const selected = yield* agents.resolve(agentID)
  if (!selected) return undefined
  const available = (yield* agents.list())
    .filter(
      (agent) =>
        agent.mode !== "primary" &&
        !agent.hidden &&
        Permission.evaluate(SubagentTool.name, agent.id, selected.permissions).effect !== "deny",
    )
    .toSorted((a, b) => a.id.localeCompare(b.id))
  if (available.length === 0) return undefined
  return [
    "Available subagents:",
    ...available.map(
      (agent) =>
        `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
    ),
  ].join("\n")
})

/** The text the model sees for a failed plugin call. A plain decline ends the turn, as in `canUseTool`. */
function failure(cause: Cause.Cause<Tool.Error>, onDecline: (() => void) | undefined) {
  const defect = cause.reasons.find(Cause.isDieReason)?.defect
  if (defect instanceof Permission.DeclinedError) {
    onDecline?.()
    return "The user declined this tool call"
  }
  if (Cause.hasInterruptsOnly(cause)) return "The tool call was interrupted"
  const error = cause.reasons.find(Cause.isFailReason)?.error ?? defect
  return error instanceof Error ? error.message : "The tool call failed"
}

function proxy(mcp: Mcp.Interface, server: string, tools: Definition[], run: Run): McpServerConfig {
  const config = createSdkMcpServer({
    name: server,
    tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
  })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  config.instance.server.setRequestHandler(CallToolRequestSchema, (request) =>
    run(
      Effect.gen(function* () {
        const status = (yield* mcp.servers()).find((item) => item.name === server)?.status
        if (status?.status !== "connected")
          return {
            content: [{ type: "text" as const, text: `MCP server "${server}" is not connected` }],
            isError: true,
          }
        const result = yield* mcp.callTool({ server, name: request.params.name, args: request.params.arguments })
        return {
          isError: result.isError,
          content: result.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "image" as const, data: part.data, mimeType: part.mimeType },
          ),
          ...(result.structured === undefined
            ? {}
            : { structuredContent: result.structured as Record<string, unknown> }),
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          }),
        ),
      ),
    ),
  )
  return config
}
