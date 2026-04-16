import { describe, expect, test } from "bun:test"
import { normalizeTool, snakeToCamel, normalizeInput } from "../../src/session/claude-sdk-adapter"

// ---------------------------------------------------------------------------
// normalizeTool — maps SDK PascalCase tool names to TUI lowercase
// ---------------------------------------------------------------------------

describe("normalizeTool", () => {
  test("maps all known SDK tools", () => {
    expect(normalizeTool("Read")).toBe("read")
    expect(normalizeTool("Write")).toBe("write")
    expect(normalizeTool("Edit")).toBe("edit")
    expect(normalizeTool("Bash")).toBe("bash")
    expect(normalizeTool("Glob")).toBe("glob")
    expect(normalizeTool("Grep")).toBe("grep")
    expect(normalizeTool("WebFetch")).toBe("webfetch")
    expect(normalizeTool("WebSearch")).toBe("websearch")
    expect(normalizeTool("CodeSearch")).toBe("codesearch")
    expect(normalizeTool("NotebookEdit")).toBe("notebook_edit")
    expect(normalizeTool("TodoWrite")).toBe("todowrite")
    expect(normalizeTool("Task")).toBe("task")
    expect(normalizeTool("Agent")).toBe("agent")
  })

  test("falls back to lowercase for unknown tools", () => {
    expect(normalizeTool("CustomTool")).toBe("customtool")
    expect(normalizeTool("LOUD")).toBe("loud")
  })

  test("handles MCP tools with underscores", () => {
    // MCP tools come through as lowercase already
    expect(normalizeTool("mcp__github__list_issues")).toBe("mcp__github__list_issues")
  })

  test("handles already-lowercase names", () => {
    expect(normalizeTool("read")).toBe("read")
    expect(normalizeTool("bash")).toBe("bash")
  })
})

// ---------------------------------------------------------------------------
// snakeToCamel — converts snake_case keys to camelCase
// ---------------------------------------------------------------------------

describe("snakeToCamel", () => {
  test("converts snake_case to camelCase", () => {
    expect(snakeToCamel("file_path")).toBe("filePath")
    expect(snakeToCamel("old_string")).toBe("oldString")
    expect(snakeToCamel("new_string")).toBe("newString")
    expect(snakeToCamel("replace_all")).toBe("replaceAll")
  })

  test("leaves camelCase unchanged", () => {
    expect(snakeToCamel("filePath")).toBe("filePath")
    expect(snakeToCamel("oldString")).toBe("oldString")
  })

  test("leaves single-word names unchanged", () => {
    expect(snakeToCamel("command")).toBe("command")
    expect(snakeToCamel("pattern")).toBe("pattern")
  })

  test("handles multiple underscores", () => {
    expect(snakeToCamel("very_long_name")).toBe("veryLongName")
  })
})

// ---------------------------------------------------------------------------
// normalizeInput — strips omitted keys and converts to camelCase
// ---------------------------------------------------------------------------

describe("normalizeInput", () => {
  test("converts snake_case keys in input", () => {
    const result = normalizeInput("edit", { file_path: "/foo.ts" })
    expect(result).toEqual({ filePath: "/foo.ts" })
  })

  test("omits read tool limit and offset", () => {
    const result = normalizeInput("read", { file_path: "/foo.ts", limit: 100, offset: 0 })
    expect(result).toEqual({ filePath: "/foo.ts" })
  })

  test("omits edit tool oldString/newString/replaceAll", () => {
    const result = normalizeInput("edit", {
      file_path: "/foo.ts",
      old_string: "a",
      new_string: "b",
      replace_all: false,
    })
    expect(result).toEqual({ filePath: "/foo.ts" })
  })

  test("omits write tool content", () => {
    const result = normalizeInput("write", { file_path: "/foo.ts", content: "..." })
    expect(result).toEqual({ filePath: "/foo.ts" })
  })

  test("omits bash tool timeout and description", () => {
    const result = normalizeInput("bash", { command: "pwd", timeout: 30000, description: "run pwd" })
    expect(result).toEqual({ command: "pwd" })
  })

  test("omits grep tool include", () => {
    const result = normalizeInput("grep", { pattern: "TODO", include: "*.ts" })
    expect(result).toEqual({ pattern: "TODO" })
  })

  test("passes through unknown tool input unchanged", () => {
    const result = normalizeInput("custom", { foo_bar: 1, baz: 2 })
    expect(result).toEqual({ fooBar: 1, baz: 2 })
  })

  test("handles empty input", () => {
    const result = normalizeInput("read", {})
    expect(result).toEqual({})
  })
})
