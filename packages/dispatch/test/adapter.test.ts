import { describe, expect, test } from "bun:test"
import { SdkAdapter } from "../src/sdk/adapter"

describe("normalizeTool", () => {
  test("maps SDK tools to the v2 tool names the TUI renders", () => {
    expect(SdkAdapter.normalizeTool("Bash")).toBe("shell")
    expect(SdkAdapter.normalizeTool("Read")).toBe("read")
    expect(SdkAdapter.normalizeTool("Write")).toBe("write")
    expect(SdkAdapter.normalizeTool("Edit")).toBe("edit")
    expect(SdkAdapter.normalizeTool("Glob")).toBe("glob")
    expect(SdkAdapter.normalizeTool("Grep")).toBe("grep")
    expect(SdkAdapter.normalizeTool("WebFetch")).toBe("webfetch")
    expect(SdkAdapter.normalizeTool("TodoWrite")).toBe("todowrite")
    expect(SdkAdapter.normalizeTool("Task")).toBe("subagent")
    expect(SdkAdapter.normalizeTool("Agent")).toBe("subagent")
    expect(SdkAdapter.normalizeTool("AskUserQuestion")).toBe("question")
    expect(SdkAdapter.normalizeTool("ExitPlanMode")).toBe("exitplanmode")
  })

  test("MCP tools use the v2 MCP tool name", () => {
    expect(SdkAdapter.normalizeTool("mcp__devin__ask_wiki_question")).toBe("devin_ask_wiki_question")
    expect(SdkAdapter.normalizeTool("mcp__my.server__tool")).toBe("my_server_tool")
  })
})

describe("normalizeInput", () => {
  test("file tools use v2 path fields and drop what the TUI does not show", () => {
    expect(SdkAdapter.normalizeInput("Read", { file_path: "/a.ts", offset: 1, limit: 2 })).toEqual({
      path: "/a.ts",
      offset: 1,
      limit: 2,
    })
    expect(
      SdkAdapter.normalizeInput("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b", replace_all: true }),
    ).toEqual({ path: "/a.ts" })
    expect(SdkAdapter.normalizeInput("Write", { file_path: "/a.ts", content: "x" })).toEqual({
      path: "/a.ts",
      content: "x",
    })
  })

  test("shell keeps the command and description, not the timeout", () => {
    expect(SdkAdapter.normalizeInput("Bash", { command: "ls", timeout: 5, description: "list" })).toEqual({
      command: "ls",
      description: "list",
    })
  })

  test("subagents carry the agent name lowercased", () => {
    expect(
      SdkAdapter.normalizeInput("Agent", { description: "d", prompt: "p", subagent_type: "Explore", model: "opus" }),
    ).toEqual({ description: "d", prompt: "p", agent: "explore" })
  })

  test("questions map to v2 question prompts", () => {
    expect(
      SdkAdapter.normalizeInput("AskUserQuestion", {
        questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: true }],
      }),
    ).toEqual({
      questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }], multiple: true }],
    })
  })

  test("unknown tools keep their input with camelCase keys", () => {
    expect(SdkAdapter.normalizeInput("NewTool", { some_key: 1, other: 2 })).toEqual({ someKey: 1, other: 2 })
    expect(SdkAdapter.snakeToCamel("replace_all")).toBe("replaceAll")
  })
})

describe("permission", () => {
  test("maps SDK tools to v2 permission actions", () => {
    expect(SdkAdapter.permission("Bash", { command: "ls" })).toEqual({ action: "shell", resources: ["ls"] })
    expect(SdkAdapter.permission("Write", { file_path: "/a" })).toEqual({ action: "edit", resources: ["/a"] })
    expect(SdkAdapter.permission("Task", { subagent_type: "Explore" })).toEqual({
      action: "subagent",
      resources: ["explore"],
    })
    expect(SdkAdapter.permission("WebSearch", { query: "q" })).toEqual({ action: "websearch", resources: ["q"] })
    expect(SdkAdapter.permission("mcp__devin__read_wiki_contents", {})).toEqual({
      action: "devin_read_wiki_contents",
      resources: ["*"],
    })
  })
})

describe("advisor", () => {
  test("recognizes advisor call and result blocks", () => {
    expect(SdkAdapter.isAdvisorCallBlock({ type: "server_tool_use", id: "s1", name: "advisor" })).toBe(true)
    expect(SdkAdapter.isAdvisorCallBlock({ type: "server_tool_use", id: "s1", name: "web_search" })).toBe(false)
    expect(
      SdkAdapter.isAdvisorResultBlock({ type: "advisor_tool_result", tool_use_id: "s1", content: { type: "x" } }),
    ).toBe(true)
  })

  test("result states: text, redacted note, error code", () => {
    const block = (content: SdkAdapter.AdvisorResultBlock["content"]) => ({
      type: "advisor_tool_result" as const,
      tool_use_id: "s1",
      content,
    })
    expect(SdkAdapter.advisorResultState(block({ type: "advisor_result", text: "do x" }))).toEqual({ output: "do x" })
    expect(SdkAdapter.advisorResultState(block({ type: "advisor_redacted_result" }))).toHaveProperty("output")
    expect(SdkAdapter.advisorResultState(block({ type: "advisor_tool_result_error", error_code: "busy" }))).toEqual({
      error: "Advisor unavailable (busy)",
    })
  })
})

describe("errors and finish reasons", () => {
  test("5xx errors get friendly messages", () => {
    expect(SdkAdapter.errorMessage(Object.assign(new Error("boom"), { status: 500 }))).toBe(
      "Claude internal server error",
    )
    expect(SdkAdapter.errorMessage(Object.assign(new Error("boom"), { status: 503 }))).toBe("Claude server error (503)")
    expect(SdkAdapter.errorMessage(new Error("plain"))).toBe("plain")
    expect(SdkAdapter.errorMessage("text")).toBe("text")
  })

  test("stop reasons map to v2 finishes", () => {
    expect(SdkAdapter.finishReason("tool_use")).toBe("tool-calls")
    expect(SdkAdapter.finishReason("max_tokens")).toBe("length")
    expect(SdkAdapter.finishReason("end_turn")).toBe("stop")
    expect(SdkAdapter.finishReason(null)).toBe("stop")
  })
})
