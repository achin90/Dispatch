import { describe, test, expect } from "bun:test"
import {
  uuid,
  sessionId,
  textBlock,
  thinkingBlock,
  toolUseBlock,
  assistantMessage,
  resultSuccess,
  resultError,
  resultMessage,
  systemMessage,
  messageSequence,
  simpleTextResponse,
  toolCallResponse,
  thinkingThenTextResponse,
  errorResponse,
} from "./helpers"

describe("claude-sdk helpers", () => {
  describe("content block factories", () => {
    test("textBlock produces valid TextBlock", () => {
      const block = textBlock("hello world")
      expect(block.type).toBe("text")
      expect(block.text).toBe("hello world")
      expect(block.citations).toBeNull()
    })

    test("thinkingBlock produces valid ThinkingBlock", () => {
      const block = thinkingBlock("let me think about this")
      expect(block.type).toBe("thinking")
      expect(block.thinking).toBe("let me think about this")
      expect(block.signature).toBe("mock-signature")
    })

    test("toolUseBlock produces valid ToolUseBlock", () => {
      const block = toolUseBlock("Read", { file_path: "/tmp/test.ts" })
      expect(block.type).toBe("tool_use")
      expect(block.name).toBe("Read")
      expect(block.input).toEqual({ file_path: "/tmp/test.ts" })
      expect(typeof block.id).toBe("string")
      expect(block.id.startsWith("toolu_")).toBe(true)
    })

    test("toolUseBlock allows id override", () => {
      const block = toolUseBlock("Bash", { command: "ls" }, { id: "custom-id" })
      expect(block.id).toBe("custom-id")
      expect(block.name).toBe("Bash")
    })
  })

  describe("message factories", () => {
    test("assistantMessage wraps content blocks", () => {
      const content = [textBlock("hello")]
      const msg = assistantMessage(content)
      expect(msg.type).toBe("assistant")
      expect(msg.message.content).toEqual(content)
      expect(msg.message.role).toBe("assistant")
      expect(typeof msg.uuid).toBe("string")
      expect(typeof msg.session_id).toBe("string")
      expect(msg.parent_tool_use_id).toBeNull()
    })

    test("assistantMessage allows overrides", () => {
      const msg = assistantMessage([textBlock("hi")], {
        session_id: "my-session" as any,
        parent_tool_use_id: "parent-123",
      })
      expect(msg.session_id).toBe("my-session")
      expect(msg.parent_tool_use_id).toBe("parent-123")
    })

    test("assistantMessage includes usage metadata", () => {
      const msg = assistantMessage([textBlock("test")])
      expect(msg.message.usage.input_tokens).toBeGreaterThan(0)
      expect(msg.message.usage.output_tokens).toBeGreaterThan(0)
      expect(typeof msg.message.model).toBe("string")
      expect(msg.message.stop_reason).toBe("end_turn")
    })

    test("resultSuccess produces success result", () => {
      const msg = resultSuccess()
      expect(msg.type).toBe("result")
      expect(msg.subtype).toBe("success")
      expect(msg.is_error).toBe(false)
      expect(typeof msg.result).toBe("string")
      expect(msg.usage.input_tokens).toBeGreaterThanOrEqual(0)
      expect(msg.usage.output_tokens).toBeGreaterThanOrEqual(0)
      expect(typeof msg.duration_ms).toBe("number")
      expect(typeof msg.total_cost_usd).toBe("number")
    })

    test("resultError produces error result", () => {
      const msg = resultError("error_during_execution", ["Test error"])
      expect(msg.type).toBe("result")
      expect(msg.subtype).toBe("error_during_execution")
      expect(msg.is_error).toBe(true)
      expect(msg.errors).toEqual(["Test error"])
    })

    test("resultError supports all error subtypes", () => {
      const subtypes = [
        "error_during_execution",
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ] as const
      for (const subtype of subtypes) {
        const msg = resultError(subtype)
        expect(msg.subtype).toBe(subtype)
        expect(msg.is_error).toBe(true)
      }
    })

    test("resultMessage dispatches to success or error", () => {
      const success = resultMessage("success")
      expect(success.subtype).toBe("success")
      expect("result" in success).toBe(true)

      const error = resultMessage("error_max_turns")
      expect(error.subtype).toBe("error_max_turns")
      expect("errors" in error).toBe(true)
    })

    test("systemMessage has init subtype", () => {
      const msg = systemMessage()
      expect(msg.type).toBe("system")
      expect(msg.subtype).toBe("init")
      expect(Array.isArray(msg.tools)).toBe(true)
      expect(msg.tools.length).toBeGreaterThan(0)
      expect(typeof msg.model).toBe("string")
      expect(typeof msg.cwd).toBe("string")
      expect(msg.permissionMode).toBe("default")
    })

    test("systemMessage allows overrides", () => {
      const msg = systemMessage({
        model: "claude-opus-4-20250514",
        tools: ["Read"],
        permissionMode: "bypassPermissions",
      })
      expect(msg.model).toBe("claude-opus-4-20250514")
      expect(msg.tools).toEqual(["Read"])
      expect(msg.permissionMode).toBe("bypassPermissions")
    })
  })

  describe("sequence builder", () => {
    test("messageSequence yields in order", async () => {
      const sys = systemMessage()
      const asst = assistantMessage([textBlock("hi")])
      const res = resultSuccess()

      const collected: unknown[] = []
      for await (const msg of messageSequence(sys, asst, res)) {
        collected.push(msg)
      }

      expect(collected).toHaveLength(3)
      expect(collected[0]).toBe(sys)
      expect(collected[1]).toBe(asst)
      expect(collected[2]).toBe(res)
    })

    test("messageSequence with empty input yields nothing", async () => {
      const collected: unknown[] = []
      for await (const msg of messageSequence()) {
        collected.push(msg)
      }
      expect(collected).toHaveLength(0)
    })
  })

  describe("pre-built scenarios", () => {
    test("simpleTextResponse yields system → assistant → result", async () => {
      const collected: { type: string }[] = []
      for await (const msg of simpleTextResponse("Hello!")) {
        collected.push(msg as { type: string })
      }

      expect(collected).toHaveLength(3)
      expect(collected[0]!.type).toBe("system")
      expect(collected[1]!.type).toBe("assistant")
      expect(collected[2]!.type).toBe("result")

      // Verify text content
      const asst = collected[1] as ReturnType<typeof assistantMessage>
      expect(asst.message.content[0]!.type).toBe("text")
      expect((asst.message.content[0] as { text: string }).text).toBe("Hello!")
    })

    test("simpleTextResponse shares session_id across messages", async () => {
      const sessionIds = new Set<string>()
      for await (const msg of simpleTextResponse("test")) {
        sessionIds.add((msg as { session_id: string }).session_id)
      }
      expect(sessionIds.size).toBe(1)
    })

    test("toolCallResponse yields system → assistant(tool_use) → assistant(text) → result", async () => {
      const collected: { type: string }[] = []
      for await (const msg of toolCallResponse("Read", { file_path: "/tmp/x" }, "File contents here")) {
        collected.push(msg as { type: string })
      }

      expect(collected).toHaveLength(4)
      expect(collected[0]!.type).toBe("system")
      expect(collected[1]!.type).toBe("assistant")
      expect(collected[2]!.type).toBe("assistant")
      expect(collected[3]!.type).toBe("result")

      // First assistant has tool_use
      const toolMsg = collected[1] as ReturnType<typeof assistantMessage>
      expect(toolMsg.message.content[0]!.type).toBe("tool_use")
      expect(toolMsg.message.stop_reason).toBe("tool_use")

      // Second assistant has text
      const textMsg = collected[2] as ReturnType<typeof assistantMessage>
      expect(textMsg.message.content[0]!.type).toBe("text")
    })

    test("thinkingThenTextResponse has thinking block before text block", async () => {
      const collected: { type: string }[] = []
      for await (const msg of thinkingThenTextResponse("hmm...", "The answer is 42")) {
        collected.push(msg as { type: string })
      }

      expect(collected).toHaveLength(3)
      const asst = collected[1] as ReturnType<typeof assistantMessage>
      expect(asst.message.content).toHaveLength(2)
      expect(asst.message.content[0]!.type).toBe("thinking")
      expect(asst.message.content[1]!.type).toBe("text")
      expect((asst.message.content[0] as { thinking: string }).thinking).toBe("hmm...")
      expect((asst.message.content[1] as { text: string }).text).toBe("The answer is 42")
    })

    test("errorResponse yields result with is_error=true", async () => {
      const collected: { type: string }[] = []
      for await (const msg of errorResponse("error_max_turns", ["Too many turns"])) {
        collected.push(msg as { type: string })
      }

      expect(collected).toHaveLength(2)
      expect(collected[0]!.type).toBe("system")
      expect(collected[1]!.type).toBe("result")

      const result = collected[1] as ReturnType<typeof resultError>
      expect(result.subtype).toBe("error_max_turns")
      expect(result.is_error).toBe(true)
      expect(result.errors).toEqual(["Too many turns"])
    })
  })

  describe("ID generators", () => {
    test("uuid returns unique values", () => {
      const a = uuid()
      const b = uuid()
      expect(a).not.toBe(b)
      expect(typeof a).toBe("string")
    })

    test("sessionId returns unique prefixed values", () => {
      const a = sessionId()
      const b = sessionId()
      expect(a).not.toBe(b)
      expect(a.startsWith("session-")).toBe(true)
    })
  })
})
