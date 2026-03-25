import { describe, test, expect, spyOn } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID, PartID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import {
  textBlock,
  thinkingBlock,
  toolUseBlock,
  assistantMessage as sdkAssistantMessage,
  resultSuccess,
  resultError,
  systemMessage,
  messageSequence,
} from "./helpers"
import { processClaudeSdkStream } from "../../src/session/claude-sdk-processor"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claude-sdk session loop", () => {
  describe("processClaudeSdkStream", () => {
    test("simple text response creates TextPart and completes", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage({ session_id: "s1" }),
          sdkAssistantMessage([textBlock("Hello world")], { session_id: "s1" }),
          resultSuccess({ session_id: "s1", result: "Hello world" }),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(result.metadata).toBeDefined()
        expect(result.metadata!.success).toBe(true)
        expect(result.metadata!.result).toBe("Hello world")

        // One TextPart created
        expect(parts).toHaveLength(1)
        expect(parts[0]!.type).toBe("text")
        if (parts[0]!.type === "text") {
          expect(parts[0]!.text).toBe("Hello world")
        }

        // Assistant message finalized
        expect(assistantMsg.time.completed).toBeGreaterThan(0)
        expect(assistantMsg.cost).toBeGreaterThanOrEqual(0)
        expect(assistantMsg.finish).toBe("end_turn")
        expect(assistantMsg.error).toBeUndefined()
      })
    })

    test("tool call creates ToolPart with running state", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          sdkAssistantMessage(
            [toolUseBlock("Read", { file_path: "/tmp/test.ts" })],
            { session_id: "s1", message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [toolUseBlock("Read", { file_path: "/tmp/test.ts" })],
              model: "claude-sonnet-4-20250514",
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, server_tool_use: null, service_tier: null },
              container: null,
              context_management: null,
            }},
          ),
          sdkAssistantMessage([textBlock("Done reading")], { session_id: "s1" }),
          resultSuccess({ session_id: "s1", result: "Done reading" }),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")

        // ToolPart + TextPart
        expect(parts).toHaveLength(2)
        expect(parts[0]!.type).toBe("tool")
        if (parts[0]!.type === "tool") {
          expect(parts[0]!.tool).toBe("Read")
          expect(parts[0]!.state.status).toBe("running")
          expect(parts[0]!.state.input).toEqual({ file_path: "/tmp/test.ts" })
        }
        expect(parts[1]!.type).toBe("text")
      })
    })

    test("thinking + text creates ReasoningPart then TextPart", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          sdkAssistantMessage(
            [thinkingBlock("Let me think..."), textBlock("The answer is 42")],
          ),
          resultSuccess({ result: "The answer is 42" }),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(parts).toHaveLength(2)
        expect(parts[0]!.type).toBe("reasoning")
        if (parts[0]!.type === "reasoning") {
          expect(parts[0]!.text).toBe("Let me think...")
        }
        expect(parts[1]!.type).toBe("text")
        if (parts[1]!.type === "text") {
          expect(parts[1]!.text).toBe("The answer is 42")
        }
      })
    })

    test("error result sets error on assistant message", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => part)

        const stream = messageSequence(
          systemMessage(),
          resultError("error_during_execution", ["Something broke"]),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("error")
        expect(result.metadata).toBeDefined()
        expect(result.metadata!.success).toBe(false)
        expect(result.metadata!.errors).toEqual(["Something broke"])
        expect(assistantMsg.error).toBeDefined()
        expect(assistantMsg.time.completed).toBeGreaterThan(0)
      })
    })

    test("error_max_turns result sets error outcome", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => part)

        const stream = messageSequence(
          systemMessage(),
          resultError("error_max_turns", ["Exceeded max turns"]),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("error")
        expect(result.metadata!.errors).toEqual(["Exceeded max turns"])
      })
    })

    test("abort signal stops processing cleanly", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const controller = new AbortController()

        // Create a stream that yields one message then the signal is aborted
        async function* abortingStream() {
          yield systemMessage()
          yield sdkAssistantMessage([textBlock("Before abort")])
          // Abort before result
          controller.abort()
          // This should not be processed
          yield sdkAssistantMessage([textBlock("After abort")])
          yield resultSuccess()
        }

        const result = await processClaudeSdkStream(abortingStream(), {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: controller.signal,
        })

        updatePartSpy.mockRestore()

        // Should get error outcome since no result message was processed
        expect(result.outcome).toBe("error")
        // Only the first text part should have been created
        expect(parts).toHaveLength(1)
        expect(parts[0]!.type).toBe("text")
        if (parts[0]!.type === "text") {
          expect(parts[0]!.text).toBe("Before abort")
        }
        // Assistant message should be marked with abort error
        expect(assistantMsg.error).toBeDefined()
      })
    })

    test("multi-turn tool calls create multiple ToolParts in order", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          // First tool call
          sdkAssistantMessage([toolUseBlock("Read", { file_path: "/a.ts" })]),
          // Second tool call
          sdkAssistantMessage([toolUseBlock("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })]),
          // Final text
          sdkAssistantMessage([textBlock("Done editing")]),
          resultSuccess({ result: "Done editing" }),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(parts).toHaveLength(3)
        expect(parts[0]!.type).toBe("tool")
        if (parts[0]!.type === "tool") {
          expect(parts[0]!.tool).toBe("Read")
        }
        expect(parts[1]!.type).toBe("tool")
        if (parts[1]!.type === "tool") {
          expect(parts[1]!.tool).toBe("Edit")
        }
        expect(parts[2]!.type).toBe("text")
      })
    })

    test("result message updates assistant tokens and cost", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => part)

        const stream = messageSequence(
          systemMessage(),
          sdkAssistantMessage([textBlock("hi")]),
          resultSuccess({
            total_cost_usd: 0.05,
            num_turns: 3,
          }),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(assistantMsg.cost).toBe(0.05)
        expect(assistantMsg.tokens.input).toBeGreaterThanOrEqual(0)
        expect(assistantMsg.tokens.output).toBeGreaterThanOrEqual(0)
        expect(result.metadata!.num_turns).toBe(3)
      })
    })

    test("unsupported message types are ignored", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          // Inject fake message types that should be ignored
          { type: "auth_status", isAuthenticating: false, output: [], uuid: "u1", session_id: "s1" } as any,
          { type: "status", session_id: "s1", uuid: "u2", status: "busy" } as any,
          sdkAssistantMessage([textBlock("Still works")]),
          resultSuccess(),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(parts).toHaveLength(1)
        expect(parts[0]!.type).toBe("text")
      })
    })

    test("mixed content blocks in single assistant message all create parts", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          sdkAssistantMessage([
            thinkingBlock("Hmm let me think"),
            textBlock("Here's my plan"),
            toolUseBlock("Bash", { command: "ls" }),
          ]),
          resultSuccess(),
        )

        const result = await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(result.outcome).toBe("stop")
        expect(parts).toHaveLength(3)
        expect(parts[0]!.type).toBe("reasoning")
        expect(parts[1]!.type).toBe("text")
        expect(parts[2]!.type).toBe("tool")
      })
    })

    test("each part gets unique ID and correct session/message IDs", async () => {
      await withInstance(async () => {
        const session = await Session.create({})
        const assistantMsg = makeAssistantMessage(session.id)
        await Session.updateMessage(assistantMsg)

        const parts: MessageV2.Part[] = []
        const updatePartSpy = spyOn(Session, "updatePart").mockImplementation(async (part: any) => {
          parts.push(part)
          return part
        })

        const stream = messageSequence(
          systemMessage(),
          sdkAssistantMessage([textBlock("a"), textBlock("b"), textBlock("c")]),
          resultSuccess(),
        )

        await processClaudeSdkStream(stream, {
          assistantMessage: assistantMsg,
          sessionID: session.id,
          abort: new AbortController().signal,
        })

        updatePartSpy.mockRestore()

        expect(parts).toHaveLength(3)
        const ids = new Set(parts.map((p) => p.id))
        expect(ids.size).toBe(3)

        for (const part of parts) {
          expect(part.sessionID).toBe(session.id)
          expect(part.messageID).toBe(assistantMsg.id)
        }
      })
    })
  })
})
