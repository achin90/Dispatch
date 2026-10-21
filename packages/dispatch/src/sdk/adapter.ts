export * as SdkAdapter from "./adapter.js"

import { McpTool } from "@opencode/core/tool/mcp"

/**
 * Pure mapping from Claude Agent SDK tool calls to the v2 vocabulary: tool part names and
 * input shapes the TUI renders, and the permission actions v2 rules are written against.
 */

const TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: "shell",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  Task: "subagent",
  Agent: "subagent",
  AskUserQuestion: "question",
  Skill: "skill",
}

export const isSubagentTool = (name: string) => name === "Agent" || name === "Task"

/** `mcp__<server>__<tool>` → `{ server, tool }`. */
export function parseMcpTool(name: string) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? { server: match[1], tool: match[2] } : undefined
}

/** The v2 tool part name for an SDK tool. */
export function normalizeTool(name: string): string {
  const mapped = TOOL_NAMES[name]
  if (mapped) return mapped
  const mcp = parseMcpTool(name)
  if (mcp) return McpTool.name(mcp.server, mcp.tool)
  return name.toLowerCase()
}

/** snake_case → camelCase, e.g. file_path → filePath. */
export function snakeToCamel(value: string) {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())
}

const camel = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).map(([key, value]) => [snakeToCamel(key), value]))

const string = (value: unknown) => (typeof value === "string" ? value : undefined)

const defined = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

/** The input shape the v2 TUI renders for a tool, derived from the SDK's input. */
export function normalizeInput(name: string, raw: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "Bash":
      return defined({ command: string(raw.command), description: string(raw.description) })
    case "Read":
      return defined({ path: string(raw.file_path), offset: raw.offset, limit: raw.limit })
    case "Write":
      return defined({ path: string(raw.file_path), content: string(raw.content) })
    case "Edit":
    case "MultiEdit":
      return defined({ path: string(raw.file_path) })
    case "NotebookEdit":
      return defined({ path: string(raw.notebook_path) })
    case "Glob":
      return defined({ pattern: string(raw.pattern), path: string(raw.path) })
    case "Grep":
      return defined({ pattern: string(raw.pattern), path: string(raw.path), include: string(raw.glob) })
    case "WebFetch":
      return defined({ url: string(raw.url), prompt: string(raw.prompt) })
    case "WebSearch":
      return defined({ query: string(raw.query) })
    case "TodoWrite":
      return { todos: raw.todos }
    case "Task":
    case "Agent":
      return defined({
        description: string(raw.description),
        prompt: string(raw.prompt),
        agent: string(raw.subagent_type)?.toLowerCase(),
        // The PreToolUse hook always forces `run_in_background: false`; show what actually runs.
        background: false,
      })
    case "AskUserQuestion":
      return { questions: questions(raw) }
    case "Skill":
      return defined({ id: string(raw.skill) ?? string(raw.name) })
  }
  return camel(raw)
}

export interface Question {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple: boolean
}

/** AskUserQuestion input → v2 question prompts. */
export function questions(raw: Record<string, unknown>): Question[] {
  if (!Array.isArray(raw.questions)) return []
  return raw.questions.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const value = item as Record<string, unknown>
    return [
      {
        question: string(value.question) ?? "",
        header: string(value.header) ?? "",
        options: Array.isArray(value.options)
          ? value.options.flatMap((option: unknown) => {
              if (typeof option !== "object" || option === null) return []
              const entry = option as Record<string, unknown>
              return [{ label: string(entry.label) ?? "", description: string(entry.description) ?? "" }]
            })
          : [],
        multiple: value.multiSelect === true,
      },
    ]
  })
}

/** The path a file tool reads or writes, if any. */
export function filePath(name: string, input: Record<string, unknown>) {
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit") return string(input.file_path)
  if (name === "NotebookEdit") return string(input.notebook_path)
  return undefined
}

/** The directory a search tool walks, if any. */
export function searchPath(name: string, input: Record<string, unknown>) {
  if (name === "Glob" || name === "Grep") return string(input.path)
  return undefined
}

/**
 * The v2 permission action and resources for a tool that has no richer mapping
 * (file tools go through FileAccess and shell commands through the shell parser).
 */
export function permission(name: string, input: Record<string, unknown>): { action: string; resources: string[] } {
  const one = (value: string | undefined) => [value ?? "*"]
  switch (name) {
    case "Read":
      return { action: "read", resources: one(string(input.file_path)) }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { action: "edit", resources: one(filePath(name, input)) }
    case "Bash":
      return { action: "shell", resources: one(string(input.command)) }
    case "Glob":
      return { action: "glob", resources: one(string(input.pattern)) }
    case "Grep":
      return { action: "grep", resources: one(string(input.pattern)) }
    case "WebFetch":
      return { action: "webfetch", resources: one(string(input.url)) }
    case "WebSearch":
      return { action: "websearch", resources: one(string(input.query)) }
    case "TodoWrite":
      return { action: "todowrite", resources: ["*"] }
    case "Task":
    case "Agent":
      return { action: "subagent", resources: one(string(input.subagent_type)?.toLowerCase()) }
    case "AskUserQuestion":
      return { action: "question", resources: ["*"] }
    case "Skill":
      return { action: "skill", resources: one(string(input.skill)) }
  }
  const mcp = parseMcpTool(name)
  if (mcp) return { action: McpTool.name(mcp.server, mcp.tool), resources: ["*"] }
  return { action: name.toLowerCase(), resources: ["*"] }
}

// The CLI's server-side advisor tool is not in the SDK's Beta types, so its blocks are read
// structurally. Both the call (server_tool_use) and its result arrive as assistant content.
export interface AdvisorCallBlock {
  readonly type: "server_tool_use"
  readonly id: string
  readonly name: "advisor"
}

export interface AdvisorResultBlock {
  readonly type: "advisor_tool_result"
  readonly tool_use_id: string
  readonly content: { readonly type: string; readonly text?: string; readonly error_code?: string }
}

export function isAdvisorCallBlock(block: unknown): block is AdvisorCallBlock {
  const value = block as Partial<AdvisorCallBlock> | null
  return value?.type === "server_tool_use" && value.name === "advisor" && typeof value.id === "string"
}

export function isAdvisorResultBlock(block: unknown): block is AdvisorResultBlock {
  const value = block as Partial<AdvisorResultBlock> | null
  return value?.type === "advisor_tool_result" && typeof value.tool_use_id === "string" && !!value.content
}

/** advisor_result is plain text, advisor_redacted_result only the model can read, and errors carry a code. */
export function advisorResultState(block: AdvisorResultBlock): { error: string } | { output: string } {
  if (block.content.type === "advisor_tool_result_error")
    return { error: `Advisor unavailable (${block.content.error_code ?? "unknown error"})` }
  if (block.content.type === "advisor_result" && block.content.text) return { output: block.content.text }
  return {
    output: "The advisor reviewed the conversation. Its advice went straight to the model and isn't shown here.",
  }
}

/** Maps SDK and API stop reasons to v2 finish reasons. */
export function finishReason(stop: string | null | undefined) {
  if (stop === "max_tokens") return "length" as const
  if (stop === "tool_use") return "tool-calls" as const
  if (stop === "refusal") return "content-filter" as const
  return "stop" as const
}

/** Friendly message for SDK and API errors. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const record = error as unknown as Record<string, unknown>
    const status = record.status ?? record.statusCode
    if (status === 500 || status === "500") return "Claude internal server error"
    if (typeof status === "number" && status >= 500) return `Claude server error (${status})`
    return error.message || "Unknown error"
  }
  if (typeof error === "string") return error
  return "Unknown error"
}
