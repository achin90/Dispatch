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
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { SessionID } from "@/session/schema"

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

  // For MCP tools or unknown tools, try common field names
  if (typeof input.file_path === "string") return [input.file_path]
  if (typeof input.path === "string") return [input.path]
  if (typeof input.command === "string") return [input.command]

  return [toolName]
}

// ---------------------------------------------------------------------------
// Derive permission name from tool name
// ---------------------------------------------------------------------------

export function derivePermissionName(toolName: string): string {
  // Map SDK tool names to the permission names used by the existing system
  switch (toolName) {
    case "Read":
      return "read"
    case "Write":
      return "write"
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
      // MCP tools come as "mcp__server__tool" — pass through as-is
      return toolName.toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// Diff generation for edit/write tools
// ---------------------------------------------------------------------------

function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )
  if (contentLines.length === 0) return diff
  return diff
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
      const contentOld = (await Filesystem.exists(filePath)) ? await Filesystem.readText(filePath) : ""
      const contentNew = contentOld.replace(oldString, newString)
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
// Create canUseTool callback
// ---------------------------------------------------------------------------

export interface CanUseToolBridgeOptions {
  sessionID: SessionID
  ruleset?: Permission.Ruleset
}

export function createCanUseToolBridge(options: CanUseToolBridgeOptions): CanUseTool {
  // Bind the callback to the current Instance ALS context.
  // The Agent SDK spawns a subprocess and calls canUseTool from a stream
  // reader context that may lose the AsyncLocalStorage context. Without
  // this bind, Permission.ask() and Bus.publish() would operate on a
  // different Instance state than what Permission.reply() sees from the
  // HTTP route handler.
  return Instance.bind(async (
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    const { signal } = callOptions
    const patterns = extractPatterns(toolName, input)
    const permission = derivePermissionName(toolName)
    const requestID = PermissionID.ascending()

    // If the signal is already aborted, deny immediately
    if (signal.aborted) {
      return { behavior: "deny", message: "Request aborted" }
    }

    // Generate diff metadata for edit/write tools
    const diffInfo = await generateEditDiff(toolName, input)
    const metadata: Record<string, unknown> = { toolName, title: callOptions.title }
    if (diffInfo) {
      metadata.filepath = diffInfo.filepath
      metadata.diff = diffInfo.diff
    }

    try {
      // Use Permission.ask() which registers in the pending map,
      // publishes the Bus event for the TUI, and waits for the user's reply.
      // This ensures Permission.reply() (called by the server route when the
      // TUI responds) can find the request and resolve it.
      await Promise.race([
        Permission.ask({
          id: requestID,
          sessionID: options.sessionID,
          permission,
          patterns,
          metadata,
          always: patterns,
          ruleset: options.ruleset ?? [],
        }),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
        }),
      ])
      return { behavior: "allow", updatedInput: input }
    } catch (error) {
      if (error instanceof Permission.RejectedError || error instanceof Permission.CorrectedError) {
        return { behavior: "deny", message: "User rejected permission" }
      }
      if (error instanceof Permission.DeniedError) {
        return { behavior: "deny", message: "Permission denied by ruleset" }
      }
      // Abort or unexpected error
      return { behavior: "deny", message: error instanceof Error ? error.message : "Permission denied" }
    }
  })
}
