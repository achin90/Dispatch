import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { processClaudeSdkStream } from "../../src/session/claude-sdk-processor"
import { resolveApiKey } from "../../src/session/claude-sdk-query"
import { query } from "@anthropic-ai/claude-agent-sdk"

const hasApiKey = !!process.env.ANTHROPIC_API_KEY

function run<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

const svc = {
  create(input?: Parameters<Session.Interface["create"]>[0]) {
    return run(Session.Service.use((s) => s.create(input)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(Session.Service.use((s) => s.updateMessage(msg)))
  },
}

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({ directory: tmp.path, fn })
}

function makeAssistantMessage(sessionID: SessionID): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: MessageID.ascending(),
    modelID: ModelID.make("claude-sonnet-4-20250514"),
    providerID: ProviderID.make("anthropic"),
    mode: "default",
    agent: "default",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  }
}

describe("claude-sdk integration", () => {
  test.skipIf(!hasApiKey)(
    "full round trip: query() → processClaudeSdkStream → MessageV2 parts",
    async () => {
      await withInstance(async () => {
        const session = await svc.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await svc.updateMessage(assistantMsg)

        const apiKey = await resolveApiKey()
        expect(apiKey).toBeDefined()

        const controller = new AbortController()

        const stream = query({
          prompt: "What is 2+2? Reply with just the number, nothing else.",
          options: {
            model: "claude-sonnet-4-20250514",
            cwd: process.cwd(),
            permissionMode: "plan", // plan mode = no tool execution
            maxTurns: 1,
            env: {
              ...process.env as Record<string, string>,
              ANTHROPIC_API_KEY: apiKey!,
            },
            abortController: controller,
          },
        })

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: controller.signal,
          cwd: "/tmp",
        })

        // Should complete successfully
        expect(result.outcome).toBe("stop")
        expect(result.metadata).toBeDefined()
        expect(result.metadata!.success).toBe(true)

        // Assistant message should be finalized
        expect(assistantMsg.time.completed).toBeGreaterThan(0)
        expect(assistantMsg.tokens.input).toBeGreaterThan(0)
        expect(assistantMsg.tokens.output).toBeGreaterThan(0)
        expect(assistantMsg.cost).toBeGreaterThan(0)
      })
    },
    60000, // 60s timeout for API call
  )
})
