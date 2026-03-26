import { describe, test, expect } from "bun:test"
import {
  textBlock,
  thinkingBlock,
  toolUseBlock,
  assistantMessage,
  resultSuccess,
  resultError,
  systemMessage,
} from "./helpers"
import {
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
  textBlockToPart,
  thinkingBlockToPart,
  toolUseBlockToPart,
  contentBlockToPart,
  assistantMessageToParts,
  resultMessageToMetadata,
  systemMessageToMetadata,
} from "../../src/session/claude-sdk-adapter"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"

const sid = SessionID.make("ses_test-session")
const mid = MessageID.ascending()

describe("claude-sdk message mapping", () => {
  describe("type guards", () => {
    test("isTextBlock identifies text blocks", () => {
      expect(isTextBlock(textBlock("hi"))).toBe(true)
      expect(isTextBlock(thinkingBlock("hmm"))).toBe(false)
      expect(isTextBlock(toolUseBlock("Read", {}))).toBe(false)
    })

    test("isThinkingBlock identifies thinking blocks", () => {
      expect(isThinkingBlock(thinkingBlock("hmm"))).toBe(true)
      expect(isThinkingBlock(textBlock("hi"))).toBe(false)
    })

    test("isToolUseBlock identifies tool_use blocks", () => {
      expect(isToolUseBlock(toolUseBlock("Bash", { command: "ls" }))).toBe(true)
      expect(isToolUseBlock(textBlock("hi"))).toBe(false)
    })
  })

  describe("textBlockToPart", () => {
    test("maps TextBlock to MessageV2.TextPart", () => {
      const block = textBlock("Hello world")
      const part = textBlockToPart(block, sid, mid)

      expect(part.type).toBe("text")
      expect(part.text).toBe("Hello world")
      expect(part.sessionID).toBe(sid)
      expect(part.messageID).toBe(mid)
      expect(typeof part.id).toBe("string")
      expect(part.time).toBeDefined()
      expect(part.time!.start).toBeGreaterThan(0)
    })

    test("maps empty text", () => {
      const part = textBlockToPart(textBlock(""), sid, mid)
      expect(part.text).toBe("")
    })
  })

  describe("thinkingBlockToPart", () => {
    test("maps ThinkingBlock to MessageV2.ReasoningPart", () => {
      const block = thinkingBlock("Let me think about this carefully")
      const part = thinkingBlockToPart(block, sid, mid)

      expect(part.type).toBe("reasoning")
      expect(part.text).toBe("Let me think about this carefully")
      expect(part.sessionID).toBe(sid)
      expect(part.messageID).toBe(mid)
      expect(part.time.start).toBeGreaterThan(0)
    })
  })

  describe("toolUseBlockToPart", () => {
    test("maps ToolUseBlock to MessageV2.ToolPart with running state", () => {
      const block = toolUseBlock("Read", { file_path: "/tmp/test.ts" })
      const part = toolUseBlockToPart(block, sid, mid)

      expect(part.type).toBe("tool")
      expect(part.tool).toBe("read")
      expect(part.callID).toBe(block.id)
      expect(part.state.status).toBe("running")
      expect(part.state.input).toEqual({ filePath: "/tmp/test.ts" })
      expect(part.sessionID).toBe(sid)
      expect(part.messageID).toBe(mid)
    })

    test("maps tool with empty input", () => {
      const block = toolUseBlock("Glob", {})
      const part = toolUseBlockToPart(block, sid, mid)
      expect(part.state.input).toEqual({})
    })

    test("running state has start time", () => {
      const block = toolUseBlock("Bash", { command: "echo hi" })
      const part = toolUseBlockToPart(block, sid, mid)
      expect(part.state.status).toBe("running")
      if (part.state.status === "running") {
        expect(part.state.time.start).toBeGreaterThan(0)
      }
    })
  })

  describe("contentBlockToPart", () => {
    test("dispatches text blocks", () => {
      const part = contentBlockToPart(textBlock("test"), sid, mid)
      expect(part).not.toBeNull()
      expect(part!.type).toBe("text")
    })

    test("dispatches thinking blocks", () => {
      const part = contentBlockToPart(thinkingBlock("think"), sid, mid)
      expect(part).not.toBeNull()
      expect(part!.type).toBe("reasoning")
    })

    test("dispatches tool_use blocks", () => {
      const part = contentBlockToPart(toolUseBlock("Edit", {}), sid, mid)
      expect(part).not.toBeNull()
      expect(part!.type).toBe("tool")
    })

    test("returns null for unsupported block types", () => {
      const unsupported = { type: "redacted_thinking", data: "abc" } as any
      const part = contentBlockToPart(unsupported, sid, mid)
      expect(part).toBeNull()
    })
  })

  describe("assistantMessageToParts", () => {
    test("maps single text content", () => {
      const msg = assistantMessage([textBlock("Hello")])
      const parts = assistantMessageToParts(msg, sid, mid)

      expect(parts).toHaveLength(1)
      expect(parts[0]!.type).toBe("text")
      expect((parts[0] as { text: string }).text).toBe("Hello")
    })

    test("maps single tool_use content", () => {
      const msg = assistantMessage([toolUseBlock("Read", { file_path: "/x" })])
      const parts = assistantMessageToParts(msg, sid, mid)

      expect(parts).toHaveLength(1)
      expect(parts[0]!.type).toBe("tool")
    })

    test("maps mixed content in order", () => {
      const msg = assistantMessage([
        thinkingBlock("Let me think..."),
        textBlock("Here's my answer"),
        toolUseBlock("Bash", { command: "ls" }),
      ])
      const parts = assistantMessageToParts(msg, sid, mid)

      expect(parts).toHaveLength(3)
      expect(parts[0]!.type).toBe("reasoning")
      expect(parts[1]!.type).toBe("text")
      expect(parts[2]!.type).toBe("tool")
    })

    test("filters out unsupported blocks", () => {
      const msg = assistantMessage([
        textBlock("hi"),
        { type: "redacted_thinking", data: "secret" } as any,
        thinkingBlock("visible"),
      ])
      const parts = assistantMessageToParts(msg, sid, mid)

      expect(parts).toHaveLength(2)
      expect(parts[0]!.type).toBe("text")
      expect(parts[1]!.type).toBe("reasoning")
    })

    test("returns empty array for empty content", () => {
      const msg = assistantMessage([])
      const parts = assistantMessageToParts(msg, sid, mid)
      expect(parts).toHaveLength(0)
    })

    test("all parts share session and message IDs", () => {
      const msg = assistantMessage([textBlock("a"), textBlock("b")])
      const parts = assistantMessageToParts(msg, sid, mid)

      for (const part of parts) {
        expect(part.sessionID).toBe(sid)
        expect(part.messageID).toBe(mid)
      }
    })

    test("each part gets a unique id", () => {
      const msg = assistantMessage([textBlock("a"), textBlock("b"), textBlock("c")])
      const parts = assistantMessageToParts(msg, sid, mid)
      const ids = new Set(parts.map((p) => p.id))
      expect(ids.size).toBe(3)
    })
  })

  describe("resultMessageToMetadata", () => {
    test("maps success result", () => {
      const msg = resultSuccess({ result: "Task completed" })
      const meta = resultMessageToMetadata(msg)

      expect(meta.success).toBe(true)
      expect(meta.result).toBe("Task completed")
      expect(meta.errors).toBeUndefined()
      expect(meta.duration_ms).toBeGreaterThan(0)
      expect(meta.total_cost_usd).toBeGreaterThanOrEqual(0)
      expect(meta.tokens.input).toBeGreaterThanOrEqual(0)
      expect(meta.tokens.output).toBeGreaterThanOrEqual(0)
      expect(typeof meta.tokens.cache_read).toBe("number")
      expect(typeof meta.tokens.cache_write).toBe("number")
    })

    test("maps error result", () => {
      const msg = resultError("error_during_execution", ["Something broke"])
      const meta = resultMessageToMetadata(msg)

      expect(meta.success).toBe(false)
      expect(meta.errors).toEqual(["Something broke"])
      expect(meta.result).toBeUndefined()
    })

    test("maps error_max_turns", () => {
      const msg = resultError("error_max_turns", ["Exceeded max turns"])
      const meta = resultMessageToMetadata(msg)

      expect(meta.success).toBe(false)
      expect(meta.errors).toEqual(["Exceeded max turns"])
    })

    test("maps error_max_budget_usd", () => {
      const msg = resultError("error_max_budget_usd", ["Budget exceeded"])
      const meta = resultMessageToMetadata(msg)

      expect(meta.success).toBe(false)
      expect(meta.stop_reason).toBeNull()
    })

    test("preserves stop_reason", () => {
      const msg = resultSuccess({ stop_reason: "end_turn" })
      const meta = resultMessageToMetadata(msg)
      expect(meta.stop_reason).toBe("end_turn")
    })

    test("preserves num_turns", () => {
      const msg = resultSuccess({ num_turns: 5 })
      const meta = resultMessageToMetadata(msg)
      expect(meta.num_turns).toBe(5)
    })
  })

  describe("systemMessageToMetadata", () => {
    test("extracts init metadata", () => {
      const msg = systemMessage({
        model: "claude-opus-4-20250514",
        tools: ["Read", "Bash"],
        cwd: "/home/user/project",
        permissionMode: "acceptEdits",
      })
      const meta = systemMessageToMetadata(msg)

      expect(meta.model).toBe("claude-opus-4-20250514")
      expect(meta.tools).toEqual(["Read", "Bash"])
      expect(meta.cwd).toBe("/home/user/project")
      expect(meta.permission_mode).toBe("acceptEdits")
      expect(typeof meta.session_id).toBe("string")
    })

    test("extracts default values", () => {
      const msg = systemMessage()
      const meta = systemMessageToMetadata(msg)

      expect(meta.tools.length).toBeGreaterThan(0)
      expect(meta.permission_mode).toBe("default")
    })
  })

  describe("Zod schema validation", () => {
    test("textBlockToPart output passes MessageV2.TextPart schema", () => {
      const part = textBlockToPart(textBlock("Hello"), sid, mid)
      const result = MessageV2.TextPart.safeParse(part)
      expect(result.success).toBe(true)
      if (!result.success) {
        throw new Error(`TextPart validation failed: ${JSON.stringify(result.error.issues)}`)
      }
    })

    test("thinkingBlockToPart output passes MessageV2.ReasoningPart schema", () => {
      const part = thinkingBlockToPart(thinkingBlock("thinking..."), sid, mid)
      const result = MessageV2.ReasoningPart.safeParse(part)
      expect(result.success).toBe(true)
      if (!result.success) {
        throw new Error(`ReasoningPart validation failed: ${JSON.stringify(result.error.issues)}`)
      }
    })

    test("toolUseBlockToPart output passes MessageV2.ToolPart schema", () => {
      const part = toolUseBlockToPart(toolUseBlock("Read", { file_path: "/tmp/x" }), sid, mid)
      const result = MessageV2.ToolPart.safeParse(part)
      expect(result.success).toBe(true)
      if (!result.success) {
        throw new Error(`ToolPart validation failed: ${JSON.stringify(result.error.issues)}`)
      }
    })

    test("mixed assistantMessageToParts all pass their respective schemas", () => {
      const msg = assistantMessage([
        thinkingBlock("Let me reason"),
        textBlock("Here is the answer"),
        toolUseBlock("Bash", { command: "echo hi" }),
      ])
      const parts = assistantMessageToParts(msg, sid, mid)

      expect(parts).toHaveLength(3)

      const reasoningResult = MessageV2.ReasoningPart.safeParse(parts[0])
      expect(reasoningResult.success).toBe(true)
      if (!reasoningResult.success) {
        throw new Error(`ReasoningPart validation failed: ${JSON.stringify(reasoningResult.error.issues)}`)
      }

      const textResult = MessageV2.TextPart.safeParse(parts[1])
      expect(textResult.success).toBe(true)
      if (!textResult.success) {
        throw new Error(`TextPart validation failed: ${JSON.stringify(textResult.error.issues)}`)
      }

      const toolResult = MessageV2.ToolPart.safeParse(parts[2])
      expect(toolResult.success).toBe(true)
      if (!toolResult.success) {
        throw new Error(`ToolPart validation failed: ${JSON.stringify(toolResult.error.issues)}`)
      }
    })

    test("tool part with complex input passes schema", () => {
      const part = toolUseBlockToPart(
        toolUseBlock("Edit", {
          file_path: "/tmp/foo.ts",
          old_string: "const x = 1",
          new_string: "const x = 2",
        }),
        sid,
        mid,
      )
      const result = MessageV2.ToolPart.safeParse(part)
      expect(result.success).toBe(true)
      if (!result.success) {
        throw new Error(`ToolPart validation failed: ${JSON.stringify(result.error.issues)}`)
      }
    })

    test("text part with empty string passes schema", () => {
      const part = textBlockToPart(textBlock(""), sid, mid)
      const result = MessageV2.TextPart.safeParse(part)
      expect(result.success).toBe(true)
    })
  })
})
