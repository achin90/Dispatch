/**
 * Permission bridge between the Claude Agent SDK's canUseTool callback
 * and the existing Permission system.
 *
 * The Agent SDK calls canUseTool() before executing each tool.
 * This bridge calls Permission.ask() which registers the request in the
 * pending map, publishes the Bus event for the TUI, and waits for the
 * user's reply via Permission.reply().
 */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { createTwoFilesPatch } from "diff"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Question } from "@/question"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { Session } from "@/session/index"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID } from "@/session/schema"

// ---------------------------------------------------------------------------
// Pending metadata — diffs generated before tool parts may exist
// ---------------------------------------------------------------------------

const pending = new Map<string, Record<string, unknown>>()

export function popPendingMeta(callID: string): Record<string, unknown> | undefined {
  const meta = pending.get(callID)
  if (meta) pending.delete(callID)
  return meta
}

// ---------------------------------------------------------------------------
// Pattern extraction — maps tool name + input to permission patterns
// ---------------------------------------------------------------------------

export function extractPatterns(toolName: string, input: Record<string, unknown>): string[] {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (typeof input.file_path === "string") return [input.file_path]
      break
    case "Glob":
      if (typeof input.pattern === "string") return [input.pattern]
      break
    case "Grep":
      if (typeof input.path === "string") return [input.path]
      if (typeof input.pattern === "string") return [input.pattern]
      break
    case "Bash":
      if (typeof input.command === "string") return [input.command]
      break
    case "WebFetch":
    case "WebSearch":
      if (typeof input.url === "string") return [input.url]
      if (typeof input.query === "string") return [input.query]
      break
    case "NotebookEdit":
      if (typeof input.notebook_path === "string") return [input.notebook_path]
      break
  }

  if (typeof input.file_path === "string") return [input.file_path]
  if (typeof input.path === "string") return [input.path]
  if (typeof input.command === "string") return [input.command]

  return [toolName]
}

// ---------------------------------------------------------------------------
// Derive permission name from tool name
// ---------------------------------------------------------------------------

export function derivePermissionName(toolName: string): string {
  switch (toolName) {
    case "Read":
      return "read"
    case "Write":
      return "edit"
    case "Edit":
      return "edit"
    case "Bash":
      return "bash"
    case "Glob":
      return "glob"
    case "Grep":
      return "grep"
    case "WebFetch":
      return "webfetch"
    case "WebSearch":
      return "websearch"
    case "NotebookEdit":
      return "notebook_edit"
    default:
      return toolName.toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// Diff generation for edit/write tools
// ---------------------------------------------------------------------------

export function trimDiff(diff: string): string {
  const hasContent = diff
    .split("\n")
    .some(
      (line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("---") && !line.startsWith("+++"),
    )
  return hasContent ? diff : ""
}

async function generateEditDiff(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ filepath: string; diff: string } | undefined> {
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined
  if (!filePath) return undefined

  try {
    if (toolName === "Edit") {
      const oldString = typeof input.old_string === "string" ? input.old_string : ""
      const newString = typeof input.new_string === "string" ? input.new_string : ""
      const replaceAll = input.replace_all === true
      const contentOld = (await Filesystem.exists(filePath)) ? await Filesystem.readText(filePath) : ""
      const contentNew = replaceAll
        ? contentOld.replaceAll(oldString, newString)
        : contentOld.replace(oldString, newString)
      const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
      return { filepath: filePath, diff }
    }

    if (toolName === "Write") {
      const contentOld = (await Filesystem.exists(filePath)) ? await Filesystem.readText(filePath) : ""
      const contentNew = typeof input.content === "string" ? input.content : ""
      const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
      return { filepath: filePath, diff }
    }
  } catch {
    // If we can't read the file or generate a diff, proceed without it
  }

  return undefined
}

// ---------------------------------------------------------------------------
// AskUserQuestion bridge
// ---------------------------------------------------------------------------

async function question(
  input: Record<string, unknown>,
  opts: CanUseToolBridgeOptions,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const raw = Array.isArray(input.questions) ? input.questions : []

  const questions: Question.Info[] = raw.map((q: Record<string, unknown>) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : "",
    options: Array.isArray(q.options)
      ? q.options.map((o: Record<string, unknown>) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : "",
        }))
      : [],
    multiple: q.multiSelect === true,
  }))

  if (!questions.length) {
    return { behavior: "deny", message: "No questions provided" }
  }

  const answers = await Promise.race([
    Question.ask({
      sessionID: opts.sessionID,
      questions,
    }),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
    }),
  ]).catch(() => null)

  if (!answers) {
    return { behavior: "deny", message: "User dismissed the question" }
  }

  const result = Object.fromEntries(questions.map((q, i) => [q.question, answers[i] ? answers[i].join(", ") : ""]))

  return {
    behavior: "allow",
    updatedInput: { ...input, answers: result },
  }
}

// ---------------------------------------------------------------------------
// Create canUseTool callback
// ---------------------------------------------------------------------------

export interface CanUseToolBridgeOptions {
  sessionID: SessionID
  messageID: MessageID
  ruleset?: Permission.Ruleset
}

async function markToolDenied(messageID: MessageID, callID: string, error: string) {
  try {
    const parts = await MessageV2.parts(messageID)
    const part = parts.find((p) => p.type === "tool" && p.callID === callID)
    if (!part || part.type !== "tool") return
    if (part.state.status !== "running") return
    await Session.updatePart({
      ...part,
      state: {
        status: "error",
        input: part.state.input,
        error,
        time: {
          start: part.state.time.start,
          end: Date.now(),
        },
      },
    })
  } catch {
    // Best-effort
  }
}

async function updateToolMetadata(messageID: MessageID, callID: string, meta: Record<string, unknown>) {
  try {
    const parts = await MessageV2.parts(messageID)
    const part = parts.find((p) => p.type === "tool" && p.callID === callID)
    if (!part || part.type !== "tool" || part.state.status !== "running") return
    await Session.updatePart({
      ...part,
      state: {
        ...part.state,
        metadata: {
          ...(part.state.metadata ?? {}),
          ...meta,
        },
      },
    })
  } catch {
    // Best-effort
  }
}

export function createCanUseToolBridge(options: CanUseToolBridgeOptions): CanUseTool {
  return Instance.bind(
    async (
      toolName: string,
      input: Record<string, unknown>,
      callOptions: Parameters<CanUseTool>[2],
    ): Promise<PermissionResult> => {
      const { signal } = callOptions

      if (signal.aborted) {
        return { behavior: "deny", message: "Request aborted" }
      }

      if (toolName === "AskUserQuestion") {
        return question(input, options, signal)
      }

      const patterns = extractPatterns(toolName, input)
      const permission = derivePermissionName(toolName)
      const requestID = PermissionID.ascending()

      const diffInfo = await generateEditDiff(toolName, input)
      const metadata: Record<string, unknown> = { toolName, title: callOptions.title }
      if (diffInfo) {
        metadata.filepath = diffInfo.filepath
        metadata.diff = diffInfo.diff
      }
      metadata.input = input

      const toolMessageID = options.messageID

      try {
        await Promise.race([
          Permission.ask({
            id: requestID,
            sessionID: options.sessionID,
            permission,
            patterns,
            metadata,
            always: patterns,
            ruleset: options.ruleset ?? [],
            tool: {
              messageID: toolMessageID,
              callID: callOptions.toolUseID,
            },
          }),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
          }),
        ])

        if (diffInfo) {
          const meta = { diff: diffInfo.diff, filepath: diffInfo.filepath }
          pending.set(callOptions.toolUseID, meta)
          await updateToolMetadata(toolMessageID, callOptions.toolUseID, meta)
        }
        return { behavior: "allow", updatedInput: input }
      } catch (error) {
        const fromPermission =
          error instanceof Permission.RejectedError ||
          error instanceof Permission.CorrectedError ||
          error instanceof Permission.DeniedError
        if (!fromPermission) {
          Permission.reply({ requestID, reply: "reject" }).catch(() => {})
        }

        const msg =
          error instanceof Permission.RejectedError || error instanceof Permission.CorrectedError
            ? "User rejected permission"
            : error instanceof Permission.DeniedError
              ? "Permission denied by ruleset: specified a rule"
              : error instanceof Error
                ? error.message
                : "Permission denied"

        await markToolDenied(toolMessageID, callOptions.toolUseID, msg)

        return { behavior: "deny", message: msg }
      }
    },
  )
}
