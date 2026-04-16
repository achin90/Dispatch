import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import { formatActivity as sdkFormatActivity } from "../../src/session/claude-sdk-processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

// ---------------------------------------------------------------------------
// SessionProcessor.formatActivity (AI SDK path)
// ---------------------------------------------------------------------------
describe("SessionProcessor.formatActivity", () => {
  test("capitalizes tool name", () => {
    expect(SessionProcessor.formatActivity("bash", undefined)).toBe("Bash")
  })

  test("returns just name when input is undefined", () => {
    expect(SessionProcessor.formatActivity("read", undefined)).toBe("Read")
  })

  test("returns just name when input has no recognized field", () => {
    expect(SessionProcessor.formatActivity("glob", { foo: "bar" })).toBe("Glob")
  })

  test("extracts filePath", () => {
    expect(SessionProcessor.formatActivity("read", { filePath: "/src/index.ts" })).toBe("Read index.ts")
  })

  test("extracts file_path (snake_case)", () => {
    expect(SessionProcessor.formatActivity("edit", { file_path: "/src/util.ts" })).toBe("Edit util.ts")
  })

  test("filePath takes precedence over file_path", () => {
    expect(SessionProcessor.formatActivity("read", { filePath: "/a.ts", file_path: "/b.ts" })).toBe("Read a.ts")
  })

  test("extracts command", () => {
    expect(SessionProcessor.formatActivity("bash", { command: "pwd" })).toBe("Bash pwd")
  })

  test("extracts pattern", () => {
    expect(SessionProcessor.formatActivity("grep", { pattern: "TODO" })).toBe("Grep TODO")
  })

  test("extracts prompt", () => {
    expect(SessionProcessor.formatActivity("task", { prompt: "summarize" })).toBe("Task summarize")
  })

  test("extracts description", () => {
    expect(SessionProcessor.formatActivity("question", { description: "pick one" })).toBe("Question pick one")
  })

  test("shortens paths by taking last segment", () => {
    expect(SessionProcessor.formatActivity("read", { filePath: "packages/opencode/src/session/processor.ts" })).toBe(
      "Read processor.ts",
    )
  })

  test("does not shorten non-path strings", () => {
    expect(SessionProcessor.formatActivity("bash", { command: "git status" })).toBe("Bash git status")
  })

  test("handles empty input object", () => {
    expect(SessionProcessor.formatActivity("bash", {})).toBe("Bash")
  })

  test("priority: filePath > command > pattern", () => {
    expect(SessionProcessor.formatActivity("bash", { command: "ls", pattern: "*.ts", filePath: "/x.ts" })).toBe(
      "Bash x.ts",
    )
  })
})

// ---------------------------------------------------------------------------
// SDK formatActivity (Claude SDK path) — takes a ToolPart
// ---------------------------------------------------------------------------
describe("sdk formatActivity", () => {
  function tool(name: string, input: Record<string, unknown> | undefined): Parameters<typeof sdkFormatActivity>[0] {
    return {
      id: PartID.ascending(),
      sessionID: SessionID.make("test-session"),
      messageID: MessageID.ascending(),
      type: "tool" as const,
      callID: "call-1",
      tool: name,
      state: { status: "running" as const, input: input ?? {}, time: { start: Date.now() } },
    }
  }

  test("capitalizes tool name", () => {
    expect(sdkFormatActivity(tool("bash", undefined))).toBe("Bash")
  })

  test("returns just name when input is empty", () => {
    expect(sdkFormatActivity(tool("read", {}))).toBe("Read")
  })

  test("extracts filePath", () => {
    expect(sdkFormatActivity(tool("read", { filePath: "/src/index.ts" }))).toBe("Read index.ts")
  })

  test("extracts command", () => {
    expect(sdkFormatActivity(tool("bash", { command: "pwd" }))).toBe("Bash pwd")
  })

  test("extracts pattern", () => {
    expect(sdkFormatActivity(tool("grep", { pattern: "TODO" }))).toBe("Grep TODO")
  })

  test("shortens paths", () => {
    expect(sdkFormatActivity(tool("write", { filePath: "a/b/c/file.ts" }))).toBe("Write file.ts")
  })

  test("does not shorten non-path", () => {
    expect(sdkFormatActivity(tool("bash", { command: "git diff" }))).toBe("Bash git diff")
  })
})
