/**
 * Regression guard for the Effect ⇄ AsyncLocalStorage seam that the Claude
 * Agent SDK path depends on.
 *
 * Two mechanisms answer "which project directory am I working in":
 *   - the Effect context (InstanceRef / InstanceState.context), which flows
 *     into forked fibers but NOT into plain async callbacks, and
 *   - the Instance AsyncLocalStorage, which flows into plain async callbacks
 *     but NOT into fiber forks.
 *
 * The SDK invokes our callbacks (canUseTool, MCP handlers, stream processing)
 * from plain async code with no Effect fiber, so `prompt.ts` re-enters the ALS
 * via `Instance.restore(ctx, ...)` around `createClaudeSdkQuery` and
 * `processClaudeSdkStream`, and `run-service.ts`'s `attach()` prefers that ALS
 * over `Fiber.getCurrent()`.
 *
 * This seam has broken three times, each time SILENTLY: the prompt posts, the
 * session goes idle, nothing is logged, and every other test stays green
 * because nothing else drives prompt.ts's claudesdk branch. These tests do.
 */
import { describe, test, expect, mock } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceState } from "@/effect/instance-state"
import { Instance } from "@/project/instance"
import { WithInstance } from "@/project/with-instance"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tmpdir, provideInstanceEffect } from "../fixture/fixture"

/**
 * What a plain-async SDK callback can see. `ok` means the callback could read
 * the instance BOTH through the ALS directly and through an Effect run via
 * AppRuntime (which is how every real callback reaches Permission, Session,
 * etc.). Either half breaking is a silent outage in production.
 */
type Probe = { ok: boolean; ambient?: string; viaEffect?: string; error?: string }

async function probeInstance(): Promise<Probe> {
  let ambient: string
  try {
    ambient = Instance.current.directory
  } catch (error) {
    return { ok: false, error: `ALS: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const ctx = await AppRuntime.runPromise(InstanceState.context)
    return { ok: true, ambient, viaEffect: ctx.directory }
  } catch (error) {
    return { ok: false, ambient, error: `Effect: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const probes: { query?: Probe; stream?: Probe } = {}

// Replace the claude-sdk-query module so no CLI subprocess is spawned. prompt.ts
// imports it lazily (`await import("./claude-sdk-query")`), so this registration
// wins as long as it happens before the first prompt runs.
//
// createClaudeSdkQuery is called inside the first `Instance.restore`; the
// returned stream's `next()` is called by processClaudeSdkStream inside the
// second. One probe per boundary.
void mock.module("../../src/session/claude-sdk-query", () => ({
  PLUGIN_TOOL_SERVER_NAME: "opencode-plugins",
  createPluginToolMcpServer: () => undefined,
  resolveMcpServers: async () => undefined,
  // summarize.ts imports this statically; the mock must keep the whole module
  // surface or that import fails to link.
  resolveApiKey: async () => undefined,
  createClaudeSdkQuery: async () => {
    probes.query = await probeInstance()
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          probes.stream ??= await probeInstance()
          return { done: true as const, value: undefined }
        },
      }),
    }
  },
}))

// A config-declared provider whose id is "anthropic" — that id is the only
// thing prompt.ts routes on. No Anthropic credentials or network are involved:
// the claudesdk branch never touches the AI SDK client.
const providerConfig = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    anthropic: {
      name: "Anthropic",
      id: "anthropic",
      env: [],
      npm: "@ai-sdk/anthropic",
      models: {
        "claude-boundary-test": {
          id: "claude-boundary-test",
          name: "Claude Boundary Test",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 200000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}

const model = {
  providerID: ProviderV2.ID.make("anthropic"),
  modelID: ModelV2.ID.make("claude-boundary-test"),
}

describe("claude-sdk instance boundary", () => {
  test("AppRuntime resolves the instance from ALS alone (no Effect fiber)", async () => {
    await using tmp = await tmpdir({ git: true })
    // Plain async, no fiber on the stack: this is exactly where every SDK
    // callback runs. If attach() ever goes back to reading only
    // Fiber.getCurrent(), this dies with "InstanceRef not provided".
    const directory = await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await AppRuntime.runPromise(InstanceState.context)
        return ctx.directory
      },
    })
    expect(directory).toBe(tmp.path)
  })

  test(
    "prompt.ts enters the ALS around both claude-sdk boundaries",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, "opencode.json"), JSON.stringify(providerConfig))

      probes.query = undefined
      probes.stream = undefined

      // The instance is supplied through the EFFECT context only — never
      // through the ALS. That is exactly how the HTTP route reaches
      // SessionPrompt.loop in production, and it is why prompt.ts has to
      // re-enter the ALS itself. Wrapping this in WithInstance.provide would
      // leak an ambient context into the SDK callbacks and make the assertions
      // below pass even with the seam removed.
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        AppRuntime.runPromise(effect.pipe(provideInstanceEffect(tmp.path)) as Effect.Effect<A, E, never>)

      const chat = await run(Session.Service.use((svc) => svc.create({ title: "boundary" })))
      const msg = await run(
        Session.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model,
            time: { created: Date.now() },
          } satisfies SessionV1.User),
        ),
      )
      await run(
        Session.Service.use((svc) =>
          svc.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: chat.id,
            type: "text",
            text: "hello",
          } satisfies SessionV1.TextPart),
        ),
      )
      await run(SessionPrompt.Service.use((svc) => svc.loop({ sessionID: chat.id })))

      // Both boundaries must have been reached at all — if the claudesdk branch
      // stopped being taken, the probes stay undefined and this fails loudly
      // rather than vacuously passing.
      expect(probes.query, "createClaudeSdkQuery was never called").toBeDefined()
      expect(probes.stream, "processClaudeSdkStream never iterated the SDK stream").toBeDefined()

      // Instance.restore missing on either call ⇒ ok: false with the reason.
      expect(probes.query).toMatchObject({ ok: true, ambient: tmp.path, viaEffect: tmp.path })
      expect(probes.stream).toMatchObject({ ok: true, ambient: tmp.path, viaEffect: tmp.path })
    },
    30_000,
  )
})
