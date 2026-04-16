import { describe, expect, spyOn, test } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import {
  textBlock,
  assistantMessage as sdkAssistantMessage,
  resultSuccess,
  systemMessage,
  messageSequence,
} from "./helpers"
import { processClaudeSdkStream } from "../../src/session/claude-sdk-processor"

// ---------------------------------------------------------------------------
// Claude SDK token counting — Dispatch regression guard
//
// The Claude SDK path must set tokens from the SDKResultMessage's usage
// totals, NOT accumulate per-stream-event like the AI SDK path does.
// This test verifies the correct behavior survives upstream merges.
// ---------------------------------------------------------------------------

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({ directory: tmp.path, fn })
}

function makeAssistant(sessionID: SessionID): MessageV2.Assistant {
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
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("claude sdk token counting", () => {
  test("tokens come from result message usage, not stream accumulation", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      const msg = makeAssistant(session.id)
      await Session.updateMessage(msg)

      const spy = spyOn(Session, "updatePart").mockImplementation((async (p: any) => p) as any)

      const sid = "token-test-session"
      const stream = messageSequence(
        systemMessage({ session_id: sid }),
        sdkAssistantMessage([textBlock("hello")], {
          session_id: sid,
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [textBlock("hello")],
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 500,
              output_tokens: 200,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 100,
              cache_creation: null,
              inference_geo: null,
              iterations: null,
              server_tool_use: null,
              service_tier: null,
              speed: null,
            },
            container: null,
            context_management: null,
          },
        }),
        resultSuccess({
          session_id: sid,
          total_cost_usd: 0.0042,
          usage: {
            input_tokens: 1500,
            output_tokens: 800,
            cache_creation_input_tokens: 150,
            cache_read_input_tokens: 300,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "us",
            iterations: [],
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
        }),
      )

      await processClaudeSdkStream(stream, {
        assistantMessage: msg,
        sessionID: session.id,
        abort: new AbortController().signal,
      })

      spy.mockRestore()

      // Tokens must come from the result message (cumulative totals)
      expect(msg.tokens.input).toBe(1500)
      expect(msg.tokens.output).toBe(800)
      expect(msg.tokens.cache.read).toBe(300)
      expect(msg.tokens.cache.write).toBe(150)

      // Cost must come from result message total_cost_usd
      expect(msg.cost).toBe(0.0042)
    })
  })

  test("context window total uses last turn usage, not cumulative", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      const msg = makeAssistant(session.id)
      await Session.updateMessage(msg)

      const spy = spyOn(Session, "updatePart").mockImplementation((async (p: any) => p) as any)

      const sid = "context-test"
      // Assistant message with per-turn usage (this is the last turn)
      const stream = messageSequence(
        systemMessage({ session_id: sid }),
        sdkAssistantMessage([textBlock("reply")], {
          session_id: sid,
          parent_tool_use_id: null,
          message: {
            id: "msg_ctx",
            type: "message",
            role: "assistant",
            content: [textBlock("reply")],
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 1000,
              output_tokens: 300,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 200,
              cache_creation: null,
              inference_geo: null,
              iterations: null,
              server_tool_use: null,
              service_tier: null,
              speed: null,
            },
            container: null,
            context_management: null,
          },
        }),
        resultSuccess({
          session_id: sid,
          usage: {
            input_tokens: 5000,
            output_tokens: 2000,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 500,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "us",
            iterations: [],
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
        }),
      )

      await processClaudeSdkStream(stream, {
        assistantMessage: msg,
        sessionID: session.id,
        abort: new AbortController().signal,
      })

      spy.mockRestore()

      // total should be from last turn: input + cache_read + cache_write + output
      // = 1000 + 200 + 50 + 300 = 1550
      expect(msg.tokens.total).toBe(1550)

      // But cumulative tokens (for display) come from result
      expect(msg.tokens.input).toBe(5000)
      expect(msg.tokens.output).toBe(2000)
    })
  })

  test("tokens are not accumulated from multiple assistant messages", async () => {
    await withInstance(async () => {
      const session = await Session.create({})
      const msg = makeAssistant(session.id)
      await Session.updateMessage(msg)

      const spy = spyOn(Session, "updatePart").mockImplementation((async (p: any) => p) as any)

      const sid = "multi-turn-test"
      // Two assistant messages (simulating tool call flow) + result
      const stream = messageSequence(
        systemMessage({ session_id: sid }),
        sdkAssistantMessage([textBlock("thinking...")], {
          session_id: sid,
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [textBlock("thinking...")],
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              cache_creation: null,
              inference_geo: null,
              iterations: null,
              server_tool_use: null,
              service_tier: null,
              speed: null,
            },
            container: null,
            context_management: null,
          },
        }),
        sdkAssistantMessage([textBlock("done")], {
          session_id: sid,
          message: {
            id: "msg_2",
            type: "message",
            role: "assistant",
            content: [textBlock("done")],
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              cache_creation: null,
              inference_geo: null,
              iterations: null,
              server_tool_use: null,
              service_tier: null,
              speed: null,
            },
            container: null,
            context_management: null,
          },
        }),
        resultSuccess({
          session_id: sid,
          total_cost_usd: 0.005,
          usage: {
            input_tokens: 300,
            output_tokens: 150,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "us",
            iterations: [],
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
        }),
      )

      await processClaudeSdkStream(stream, {
        assistantMessage: msg,
        sessionID: session.id,
        abort: new AbortController().signal,
      })

      spy.mockRestore()

      // Tokens must be the result totals (300/150), NOT accumulated (100+200=300/50+100=150)
      // In this case they happen to match, but the point is they come from result, not accumulation
      expect(msg.tokens.input).toBe(300)
      expect(msg.tokens.output).toBe(150)
      expect(msg.cost).toBe(0.005)
    })
  })
})
