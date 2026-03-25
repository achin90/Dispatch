/**
 * Permission bridge between the Claude Agent SDK's canUseTool callback
 * and the existing Permission event system (Bus events → TUI permission dock).
 *
 * The Agent SDK calls canUseTool() before executing each tool.
 * This bridge publishes Permission.Event.Asked, waits for the user's reply
 * via Permission.Event.Replied, and returns the appropriate PermissionResult.
 */

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Bus } from "@/bus"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
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
// Create canUseTool callback
// ---------------------------------------------------------------------------

export interface CanUseToolBridgeOptions {
  sessionID: SessionID
}

export function createCanUseToolBridge(options: CanUseToolBridgeOptions): CanUseTool {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    const { signal } = callOptions
    const patterns = extractPatterns(toolName, input)
    const permission = derivePermissionName(toolName)
    const requestID = PermissionID.ascending()

    const request: Permission.Request = {
      id: requestID,
      sessionID: options.sessionID,
      permission,
      patterns,
      metadata: { toolName, title: callOptions.title },
      always: patterns,
    }

    // If the signal is already aborted, deny immediately
    if (signal.aborted) {
      return { behavior: "deny", message: "Request aborted" }
    }

    // Set up the reply listener BEFORE publishing the request
    // so we don't miss a synchronous reply from the subscriber
    return new Promise<PermissionResult>((resolve) => {
      let resolved = false

      const unsubscribe = Bus.subscribe(Permission.Event.Replied, (event) => {
        if (event.properties.requestID !== requestID) return
        if (resolved) return
        resolved = true

        unsubscribe()

        if (event.properties.reply === "reject") {
          resolve({
            behavior: "deny",
            message: "User rejected permission",
          })
        } else {
          resolve({
            behavior: "allow",
            updatedInput: input,
          })
        }
      })

      signal.addEventListener(
        "abort",
        () => {
          if (resolved) return
          resolved = true
          unsubscribe()
          resolve({
            behavior: "deny",
            message: "Request aborted",
          })
        },
        { once: true },
      )

      // Publish the request — the TUI listens for this event
      // and shows the permission dock to the user
      Bus.publish(Permission.Event.Asked, request)
    })
  }
}
