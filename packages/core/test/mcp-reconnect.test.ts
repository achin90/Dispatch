import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { hostEnvironmentLayer } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"

// Dispatch: reconnect-with-backoff and health check on top of the per-location Mcp.Service.

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Mcp.node]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) }))),
    ),
    Environment.node.replace(hostEnvironmentLayer),
  ]),
)

const server = Mcp.ServerName.make("reconnect")

// Spawning and killing processes is real work; poll on real time so the TestClock only moves when a
// test advances it, and startup timeouts never fire on their own.
const until = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    if (yield* condition) return
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  return yield* Effect.die(new Error("condition never became true within 15s"))
})

const setup = Effect.fnUntraced(function* (environment: Record<string, string> = {}) {
  const dir = yield* tmpdirScoped()
  const log = path.join(dir.path, "starts")
  const mcp = yield* Mcp.Service
  yield* mcp.add(
    server,
    new ConfigMCP.Local({
      type: "local",
      command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-reconnect.ts")],
      environment: { MCP_RECONNECT_LOG: log, ...environment },
    }),
  )
  const status = mcp.servers().pipe(Effect.map((servers) => servers.find((item) => item.name === server)?.status))
  const starts = Effect.promise(() =>
    fs
      .readFile(log, "utf8")
      .then((text) => text.split("\n").filter(Boolean).map(Number))
      .catch(() => [] as number[]),
  )
  const is = (value: string) => status.pipe(Effect.map((current) => current?.status === value))
  yield* until(is("connected"))
  return { mcp, status, starts, is }
})

describe("mcp reconnect", () => {
  it.effect("reconnects a server whose process died, after the backoff delay", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const [first] = yield* fixture.starts
      process.kill(first, "SIGKILL")
      yield* until(fixture.is("failed"))
      expect(yield* fixture.mcp.tools()).toEqual([])

      // The first retry waits five seconds.
      yield* TestClock.adjust("4900 millis")
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      expect((yield* fixture.status)?.status).toBe("failed")
      expect(yield* fixture.starts).toHaveLength(1)

      yield* TestClock.adjust("100 millis")
      yield* until(fixture.is("connected"))
      const starts = yield* fixture.starts
      expect(starts).toHaveLength(2)
      expect(starts[1]).not.toBe(first)
      expect((yield* fixture.mcp.tools()).map((tool) => tool.name)).toEqual(["echo"])
    }),
  )

  it.effect("stops reconnecting once the user disconnects the server", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const [first] = yield* fixture.starts
      process.kill(first, "SIGKILL")
      yield* until(fixture.is("failed"))
      yield* fixture.mcp.disconnect(server)
      yield* TestClock.adjust("2 minutes")
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect((yield* fixture.status)?.status).toBe("disabled")
      expect(yield* fixture.starts).toHaveLength(1)
    }),
  )

  it.effect("health check pings connected servers", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      expect(yield* fixture.mcp.health()).toEqual([{ server, healthy: true }])
      expect(yield* fixture.starts).toHaveLength(1)
    }),
  )

  it.effect("health check restarts a server that stopped answering", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ MCP_RECONNECT_UNRESPONSIVE: "1" })
      const [first] = yield* fixture.starts
      expect(yield* fixture.mcp.health()).toEqual([{ server, healthy: false }])
      yield* until(fixture.is("connected"))
      const starts = yield* fixture.starts
      expect(starts).toHaveLength(2)
      expect(starts[1]).not.toBe(first)
      expect((yield* fixture.mcp.tools()).map((tool) => tool.name)).toEqual(["echo"])
    }),
  )
})
