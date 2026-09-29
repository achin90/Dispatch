import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp/index"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout } from "../lib/effect"

// Servers from the global config reconnect through a bridge with no Instance
// context. The instance-scoped Config.get() defects there, which used to make
// every reconnect attempt fail silently and drop the server until restart.
test("globally configured server reconnects after its connection drops", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const protocol = new Server({ name: "mcp-reconnect", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      return transport.handleRequest(request)
    },
  })

  const layer = LayerNode.compile(MCP.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.die(new Error("InstanceRef not provided")),
        getGlobal: () =>
          Effect.succeed({ mcp: { remote: { type: "remote", url: server.url.toString(), oauth: false } } }),
      }),
    ],
  ])

  await Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const original = (yield* mcp.clients()).remote
    expect(original).toBeDefined()

    // status() reads the instance-scoped config, so observe clients() instead.
    yield* Effect.promise(() => original.close())
    expect((yield* mcp.clients()).remote).toBeUndefined()

    const replaced = yield* pollWithTimeout(
      Effect.gen(function* () {
        return (yield* mcp.clients()).remote
      }),
      "server never reconnected",
      "15 seconds",
    )
    expect(replaced).not.toBe(original)
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    .finally(() => server.stop(true))
}, 20_000)
