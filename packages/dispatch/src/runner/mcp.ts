export * as SdkMcp from "./mcp.js"

import { createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import type { Agent } from "@opencode/core/agent"
import { Mcp } from "@opencode/core/mcp/index"
import { SessionMessage } from "@opencode/core/session/message"
import type { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { definition, effectiveName, execute } from "@opencode/core/tool/runtime"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schedule } from "effect"

type Definition = { name: string; description?: string; inputSchema: Record<string, unknown> }

export type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

/** In-process MCP server exposing tools registered by non-builtin opencode plugins. */
export const PLUGIN_SERVER = "opencode-plugins"

// v2 tools the CLI already has its own version of, plus host-owned namespaces.
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
  "subagent",
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
export function make(mcp: Mcp.Interface, registry: Tool.Interface) {
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
    const config = createSdkMcpServer({
      name: PLUGIN_SERVER,
      tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
    })
    config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => {
        const described = definition(tool)
        return {
          name: described.name,
          description: described.description,
          inputSchema: described.inputSchema as Record<string, unknown> & { type: "object" },
        }
      }),
    }))
    config.instance.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const tool = byName.get(request.params.name)
      if (!tool)
        return Promise.resolve({
          content: [{ type: "text" as const, text: `Plugin tool "${request.params.name}" not found` }],
          isError: true,
        })
      return run(
        execute(tool, request.params.arguments ?? {}, {
          sessionID: context.sessionID,
          agent: context.agent,
          // MCP calls carry no tool_use_id; the call is not linked to a specific tool part.
          messageID: SessionMessage.ID.create(),
          id: Tool.CallID.make(`plugin_${crypto.randomUUID()}`),
          progress: () => Effect.void,
        }).pipe(
          Effect.map((result) => ({
            content: result.content.map((part) =>
              part.type === "text"
                ? { type: "text" as const, text: part.text }
                : { type: "text" as const, text: part.name ?? part.uri },
            ),
          })),
          Effect.catch((error) =>
            Effect.succeed({ content: [{ type: "text" as const, text: error.message }], isError: true }),
          ),
        ),
      )
    })
    return { [PLUGIN_SERVER]: config } satisfies Record<string, McpServerConfig>
  })

  return { servers, plugins }
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
