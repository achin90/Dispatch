export * as SdkMcp from "./mcp.js"

import { createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { Mcp } from "@opencode/core/mcp/index"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schedule } from "effect"

type Definition = { name: string; description?: string; inputSchema: Record<string, unknown> }

export type Run = <A>(effect: Effect.Effect<A, unknown, Mcp.Service>) => Promise<A>

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
export function make(mcp: Mcp.Interface) {
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
    const known = new Set((yield* mcp.servers()).map((server) => server.name))
    return Object.fromEntries(
      Array.from(cache)
        .filter(([server, tools]) => known.has(server) && tools.length > 0)
        .map(([server, tools]) => [server, proxy(server, tools, run)] as const),
    ) satisfies Record<string, McpServerConfig>
  })

  return { servers }
}

function proxy(server: string, tools: Definition[], run: Run): McpServerConfig {
  const config = createSdkMcpServer({
    name: server,
    tools: [{ name: "__init__", description: "", inputSchema: {}, handler: async () => ({ content: [] }) }],
  })
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  config.instance.server.setRequestHandler(CallToolRequestSchema, (request) =>
    run(
      Effect.gen(function* () {
        const mcp = yield* Mcp.Service
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
