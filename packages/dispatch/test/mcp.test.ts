import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Agent } from "@opencode/core/agent"
import type { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { Effect, Schema } from "effect"
import { SdkMcp } from "../src/runner/mcp"
import { SdkAdapter } from "../src/sdk/adapter"
import { agent, location, sessionID, setup } from "./fixture"

const fixture = location()

/**
 * A stand-in for v2's `subagent` tool. The bridge is generic over plugin tools; core's
 * tool-subagent tests cover the real tool's jobs, backgrounding and completion.
 */
const calls: Array<{ readonly id: string; readonly messageID: string }> = []
const interrupted = { value: false }
const subagent: Effect.Success<ReturnType<Tool.Interface["list"]>>[number] = {
  id: "subagent",
  name: "subagent",
  description: "Spawns an agent in a child session.",
  input: Schema.Struct({ mode: Schema.String }),
  execute: (input: { readonly mode: string }, context) =>
    Effect.gen(function* () {
      calls.push({ id: context.id, messageID: context.messageID })
      if (input.mode === "decline") return yield* Effect.die(new Permission.DeclinedError())
      if (input.mode === "wait")
        return yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted.value = true))))
      yield* context.progress?.({ sessionID: "ses_child", status: "running" }) ?? Effect.void
      return { content: [{ type: "text", text: "child done" }], metadata: { sessionID: "ses_child", status: "completed" } }
    }),
}

// The bridge only lists MCP servers (to skip their namespaces) and the registered plugin tools.
const mcp = { servers: () => Effect.succeed([]) } as unknown as Mcp.Interface
const registry = { list: () => Effect.succeed([subagent]) } as unknown as Tool.Interface

const bridge = (controller = new AbortController()) =>
  fixture.run(
    Effect.gen(function* () {
      yield* setup(fixture.directory, [{ action: "*", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("reviewer"), (info) => {
          info.mode = "subagent"
          info.description = "Reviews code"
        })
        editor.update(Agent.ID.make("secret"), (info) => {
          info.mode = "subagent"
          info.hidden = true
        })
      })
      const services = yield* Effect.context<Agent.Service>()
      const progress: Array<{ readonly id: string; readonly metadata: Tool.Metadata }> = []
      const metadata = new Map<string, Tool.Metadata>()
      const declines = { count: 0 }
      const servers = yield* SdkMcp.make(mcp, registry, agents).plugins(
        (effect, signal) => Effect.runPromiseWith(services)(effect, { signal }),
        { sessionID, agent },
        {
          lookup: async (toolUseID) => (toolUseID === "toolu_known" ? { messageID: "msg_parent_call" } : undefined),
          progress: (id, value) => Effect.sync(() => progress.push({ id, metadata: value })),
          metadata,
          signal: controller.signal,
          onDecline: () => {
            declines.count++
          },
          agent: async () => agent,
        },
      )
      const server = servers[SdkAdapter.PLUGIN_SERVER]
      if (server?.type !== "sdk") return yield* Effect.die(new Error("plugin server missing"))
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: "test", version: "0" })
      yield* Effect.promise(() => server.instance.connect(serverTransport))
      yield* Effect.promise(() => client.connect(clientTransport))
      return { client, progress, metadata, declines }
    }),
  )

const call = (client: Client, mode: string, toolUseID = "toolu_known") =>
  client.callTool({ name: "subagent", arguments: { mode }, _meta: { "claudecode/toolUseId": toolUseID } })

describe("plugin MCP server", () => {
  test("lists subagent with the agents it may spawn", async () => {
    const { client } = await bridge()
    const listed = await client.listTools()
    const description = listed.tools.find((tool) => tool.name === "subagent")?.description
    expect(description).toContain("Available subagents:")
    expect(description).toContain("- reviewer: Reviews code")
    expect(description).not.toContain("secret")
  })

  test("links the call to its tool part, forwards progress and keeps the result metadata", async () => {
    calls.length = 0
    const { client, progress, metadata } = await bridge()
    const result = await call(client, "progress")
    expect(result.content).toEqual([{ type: "text", text: "child done" }])
    expect(calls).toEqual([{ id: "toolu_known", messageID: "msg_parent_call" }])
    expect(progress).toEqual([{ id: "toolu_known", metadata: { sessionID: "ses_child", status: "running" } }])
    expect(metadata.get("toolu_known")).toEqual({ sessionID: "ses_child", status: "completed" })
  })

  test("a plain decline fails the call and ends the turn", async () => {
    calls.length = 0
    const { client, declines } = await bridge()
    const result = await call(client, "decline")
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "The user declined this tool call" }])
    expect(declines.count).toBe(1)
  })

  test("interrupting the drain interrupts a running call", async () => {
    // Earlier tests record calls too; the wait below must see this one start.
    calls.length = 0
    interrupted.value = false
    const controller = new AbortController()
    const { client } = await bridge(controller)
    const pending = call(client, "wait")
    for (let waited = 0; !calls.some((item) => item.id === "toolu_known") && waited < 2_000; waited += 10)
      await Bun.sleep(10)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(interrupted.value).toBe(true)
  })
})

describe("plugin tools in the SDK vocabulary", () => {
  test("parts keep the tool's v2 name and the CLI's own subagent tools are off", () => {
    expect(SdkAdapter.normalizeTool(SdkAdapter.PLUGIN_SUBAGENT)).toBe("subagent")
    expect(SdkAdapter.normalizeTool("mcp__linear__list_issues")).not.toBe("list_issues")
  })
})
