// hello

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
import { Session } from "@/session/index"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID } from "@/session/schema"

// ---------------------------------------------------------------------------
// Pending metadata — diffs generated before tool parts may exist
// ---------------------------------------------------------------------------

// The SDK calls canUseTool() concurrently with yielding the assistant message.
// Our stream processor may not have created the ToolPart yet when
// canUseTool finishes. Store diffs here keyed by toolUseID so
// finalizeRunningTools can merge them when transitioning to "completed".
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

// Returns the full unified diff when actual +/- content lines exist, or ""
// when the diff is header-only (no real changes). The <diff> TUI component
// needs intact @@ hunk markers and ---/+++ headers to render correctly —
// stripping them breaks the renderer and produces a blank diff view.
export function trimDiff(diff: string): string {
  const hasContent = diff.split("\n").some(
    (line) =>
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
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
// Create canUseTool callback
// ---------------------------------------------------------------------------

export interface CanUseToolBridgeOptions {
  sessionID: SessionID
  messageID: MessageID
  ruleset?: Permission.Ruleset
}

/**
 * When the SDK's canUseTool returns deny, the SDK handles the denial
 * internally — it never tells us to update the tool part. We need to
 * mark the part as error ourselves so the TUI shows strikethrough.
 */
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
    // Best-effort: if we can't find or update the part, the denial
    // still works — the tool just won't show strikethrough styling.
  }
}

/**
 * Update a tool part's state.metadata with additional fields (e.g., diff for edits).
 * Best-effort — if the part can't be found (race condition), the pending map
 * in finalizeRunningTools handles it.
 */
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
    // Store tool input in metadata so the TUI permission prompt can display
    // details (e.g., bash command) even when the tool part isn't synced
    // (which happens for subagent tools in child sessions).
    metadata.input = input

    const toolMessageID = options.messageID

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
          tool: {
            messageID: toolMessageID,
            callID: callOptions.toolUseID,
          },
        }),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
        }),
      ])
      // Store diff metadata so the TUI can display it.
      // The tool part may not exist yet (race between stream processing and
      // canUseTool callback), so we both try to update the part directly AND
      // stash in the pending map for finalizeRunningTools to pick up.
      if (diffInfo) {
        const meta = { diff: diffInfo.diff, filepath: diffInfo.filepath }
        pending.set(callOptions.toolUseID, meta)
        await updateToolMetadata(toolMessageID, callOptions.toolUseID, meta)
      }
      return { behavior: "allow", updatedInput: input }
    } catch (error) {
      // If the error is NOT from the Permission system (i.e. it came from the
      // abort signal winning Promise.race), the Effect fiber backing
      // Deferred.await is still alive and the globalPending entry was never
      // cleaned up.  Reject it so Effect.ensuring fires and deletes the entry.
      const fromPermission =
        error instanceof Permission.RejectedError ||
        error instanceof Permission.CorrectedError ||
        error instanceof Permission.DeniedError
      if (!fromPermission) {
        Permission.reply({ requestID, reply: "reject" }).catch(() => {})
      }

      const msg = error instanceof Permission.RejectedError || error instanceof Permission.CorrectedError
        ? "User rejected permission"
        : error instanceof Permission.DeniedError
          ? "Permission denied by ruleset: specified a rule"
          : error instanceof Error
            ? error.message
            : "Permission denied"

      // Update the tool part to error state so the TUI shows strikethrough
      await markToolDenied(toolMessageID, callOptions.toolUseID, msg)

      return { behavior: "deny", message: msg }
    }
  })
}
