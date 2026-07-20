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
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Question } from "@/question"
import * as Filesystem from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { AppRuntime } from "@/effect/app-runtime"

const log = Log.create({ service: "claude-sdk-permissions" })

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
      // MCP tools come as "mcp__server__tool" — pass through as-is
      return toolName.toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// File path helpers — normalise SDK patterns to match standard tool behaviour
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"])

/** Extract the file path from a file-based tool's input, if present. */
function extractFilePath(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined
  const raw = toolName === "NotebookEdit" ? input.notebook_path : input.file_path
  return typeof raw === "string" ? raw : undefined
}

/**
 * Normalise patterns for a file-based tool so the permission system sees the
 * same relative-path format the standard (AI SDK) tool path produces.
 *
 * Standard tools call:
 *   ctx.ask({ permission: "edit", patterns: [path.relative(Instance.worktree, filePath)] })
 *
 * Without normalisation the SDK bridge would pass the raw absolute path,
 * which doesn't match relative-path permission rules in the agent config.
 */
function normaliseFilePatterns(toolName: string, patterns: string[]): string[] {
  if (!FILE_TOOLS.has(toolName)) return patterns
  return patterns.map((p) => (path.isAbsolute(p) ? path.relative(Instance.worktree, p) : p))
}

/**
 * Check external_directory permission for a file outside the project boundary.
 * Mirrors the gate in tool/external-directory.ts that standard tools run.
 * Returns null when the file is inside the project or permission is granted;
 * returns a deny PermissionResult when the check fails.
 */
async function checkExternalDirectory(
  filePath: string,
  opts: CanUseToolBridgeOptions,
  signal: AbortSignal,
): Promise<PermissionResult | null> {
  if (Instance.containsPath(filePath)) return null

  const dir = path.dirname(filePath)
  const glob = path.join(dir, "*")
  const requestID = PermissionID.ascending()

  try {
    await Promise.race([
      AppRuntime.runPromise(
        Permission.Service.use((svc) =>
          svc.ask({
            id: requestID,
            sessionID: opts.sessionID,
            permission: "external_directory",
            patterns: [glob],
            metadata: { filepath: filePath, parentDir: dir },
            always: [glob],
            ruleset: opts.ruleset ?? [],
          }),
        ),
      ),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
      }),
    ])
    return null
  } catch (error) {
    // Clean up the pending permission entry if abort won the race
    // (same pattern as createCanUseToolBridge's catch block)
    const fromPermission =
      error instanceof Permission.DeniedError ||
      error instanceof Permission.RejectedError ||
      error instanceof Permission.CorrectedError
    if (!fromPermission) {
      AppRuntime.runPromise(Permission.Service.use((svc) => svc.reply({ requestID, reply: "reject" }))).catch(() => {})
    }

    const msg =
      error instanceof Permission.DeniedError
        ? "Permission denied by ruleset: external directory"
        : error instanceof Permission.RejectedError || error instanceof Permission.CorrectedError
          ? "User rejected permission"
          : error instanceof Error
            ? error.message
            : "Permission denied"
    return { behavior: "deny", message: msg }
  }
}

// ---------------------------------------------------------------------------
// Subagent permission propagation (PreToolUse hook)
// ---------------------------------------------------------------------------

/**
 * PreToolUse hook that propagates the session ruleset to *subagent* tool calls.
 *
 * PreToolUse is the only hook the SDK fires for a subagent tool call before it
 * runs; it carries agent_id and runs ahead of canUseTool. Without it, a
 * subagent's out-of-workspace tool call takes the SDK's default headless path
 * (auto-deny) and a permissive parent (e.g. yolo) never reaches its subagents.
 *
 * So we evaluate the same ruleset here and emit allow / deny / ask:
 *  - allow → the SDK runs the tool without consulting canUseTool (verified: yolo
 *    subagents run silently).
 *  - ask   → the SDK surfaces it as a can_use_tool control request, i.e. it DOES
 *    invoke canUseTool with options.agentID set, so the prompt reaches the TUI
 *    via our bridge (verified: build subagents prompt interactively).
 *  - deny  → the tool is blocked and canUseTool is bypassed.
 *
 * Main-thread calls (no agent_id) are passed through so canUseTool keeps owning
 * edit diffs, AskUserQuestion / ExitPlanMode routing, and interactive prompts.
 */
export function createSubagentPermissionHook(ruleset: Permission.Ruleset) {
  // Bind the current Instance ALS context: the SDK fires hooks from a stream
  // reader context that loses AsyncLocalStorage, and normaliseFilePatterns reads
  // Instance.worktree. Same reason createCanUseToolBridge binds its callback.
  return Instance.bind(async (input: unknown) => {
    const evt = input as { agent_id?: string; tool_name?: string; tool_input?: Record<string, unknown> }
    // Main thread → leave it to canUseTool.
    if (!evt.agent_id || !evt.tool_name) return { continue: true as const }

    const toolInput = evt.tool_input ?? {}
    const permission = derivePermissionName(evt.tool_name)
    const patterns = normaliseFilePatterns(evt.tool_name, extractPatterns(evt.tool_name, toolInput))

    // Combine per-pattern decisions: any deny wins; otherwise all-allow allows;
    // otherwise ask — which the SDK re-routes through canUseTool (with agentID)
    // so the prompt reaches the TUI.
    const actions = patterns.map((pattern) => Permission.evaluate(permission, pattern, ruleset).action)
    const decision: "allow" | "deny" | "ask" = actions.includes("deny")
      ? "deny"
      : actions.every((action) => action === "allow")
        ? "allow"
        : "ask"

    return {
      continue: true as const,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: decision,
        permissionDecisionReason:
          decision === "allow"
            ? "Inherited from parent session permissions"
            : `Subagent tool '${evt.tool_name}' ${decision === "deny" ? "denied" : "not pre-approved"} by parent ruleset`,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Diff generation for edit/write tools
// ---------------------------------------------------------------------------

// Returns the full unified diff when actual +/- content lines exist, or ""
// when the diff is header-only (no real changes). The <diff> TUI component
// needs intact @@ hunk markers and ---/+++ headers to render correctly —
// stripping them breaks the renderer and produces a blank diff view.
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
// AskUserQuestion bridge — routes SDK question tool through the TUI
// ---------------------------------------------------------------------------

/**
 * Converts the SDK's AskUserQuestionInput into opencode Question.Info[],
 * calls Question.ask() to show the TUI prompt, waits for answers, then
 * returns them in the format the SDK expects ({ [questionText]: answerStr }).
 */
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
    AppRuntime.runPromise(Question.Service.use((svc) => svc.ask({
      sessionID: opts.sessionID,
      questions,
    }))),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
    }),
  ]).catch(() => null)

  if (!answers) {
    return { behavior: "deny", message: "User dismissed the question" }
  }

  // The SDK expects answers as { [questionText]: answerString }.
  // Multi-select answers are comma-separated.
  const result = Object.fromEntries(questions.map((q, i) => [q.question, answers[i] ? answers[i].join(", ") : ""]))

  return {
    behavior: "allow",
    updatedInput: { ...input, answers: result },
  }
}

// ---------------------------------------------------------------------------
// ExitPlanMode bridge — switches agent when the SDK exits plan mode
// ---------------------------------------------------------------------------

/**
 * When the SDK calls ExitPlanMode, ask the user which agent to switch to
 * and create a synthetic user message so the main loop picks up the new agent.
 */
async function exitPlanMode(
  opts: CanUseToolBridgeOptions,
  signal: AbortSignal,
): Promise<PermissionResult> {
  log.info("exitPlanMode: called via canUseTool", { sessionID: opts.sessionID })
  const answers = await Promise.race([
    AppRuntime.runPromise(Question.Service.use((svc) => svc.ask({
      sessionID: opts.sessionID,
      questions: [{
        question: "Plan is complete. Which agent would you like to switch to?",
        header: "Switch Agent",
        options: [
          { label: "Build", description: "Default agent. Asks for permission on edits and bash commands" },
          { label: "Yolo", description: "Auto-approves all tool calls without asking" },
          { label: "Stay in Plan", description: "Continue refining the plan" },
        ],
      }],
    }))),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
    }),
  ]).catch(() => null)

  if (!answers || answers[0]?.[0] === "Stay in Plan") {
    log.info("exitPlanMode: user dismissed or chose to stay in plan mode")
    return { behavior: "deny", message: "User chose to stay in plan mode" }
  }

  const selectedAgent = answers[0]?.[0] === "Yolo" ? "yolo" : "build"
  log.info("exitPlanMode: user selected agent", { selectedAgent })

  // Get model info from the latest user message
  let model: MessageV2.User["model"] | undefined
  for (const item of MessageV2.stream(opts.sessionID)) {
    if (item.info.role === "user" && item.info.model) {
      model = item.info.model
      break
    }
  }
  if (!model) {
    model = await AppRuntime.runPromise(Provider.Service.use((svc) => svc.defaultModel()))
  }

  // Create synthetic user message to switch agent
  const msgId = MessageID.ascending()
  await AppRuntime.runPromise(Session.Service.use((svc) => svc.updateMessage({
    id: msgId,
    sessionID: opts.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: selectedAgent,
    model,
  } satisfies MessageV2.User)))

  await AppRuntime.runPromise(Session.Service.use((svc) => svc.updatePart({
    id: PartID.ascending(),
    messageID: msgId,
    sessionID: opts.sessionID,
    type: "text",
    text: "The plan has been approved, you can now edit files. Execute the plan",
    synthetic: true,
  } satisfies MessageV2.TextPart)))

  log.info("exitPlanMode: synthetic user message created", { msgId, selectedAgent })
  return { behavior: "allow" }
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
    const runState = part.state as MessageV2.ToolStateRunning
    await AppRuntime.runPromise(Session.Service.use((svc) => svc.updatePart({
      ...part,
      state: {
        status: "error",
        input: runState.input,
        error,
        time: {
          start: runState.time.start,
          end: Date.now(),
        },
      },
    })))
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
    const runState = part.state as MessageV2.ToolStateRunning
    await AppRuntime.runPromise(Session.Service.use((svc) => svc.updatePart({
      ...part,
      state: {
        ...runState,
        metadata: {
          ...(runState.metadata ?? {}),
          ...meta,
        },
      },
    })))
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
  return Instance.bind(
    async (
      toolName: string,
      input: Record<string, unknown>,
      callOptions: Parameters<CanUseTool>[2],
    ): Promise<PermissionResult> => {
      const { signal } = callOptions

      // If the signal is already aborted, deny immediately
      if (signal.aborted) {
        return { behavior: "deny", message: "Request aborted" }
      }

      log.info("canUseTool: received tool call", { toolName, sessionID: options.sessionID })

      // ------------------------------------------------------------------
      // AskUserQuestion: route through the Question system instead of
      // the generic permission flow. The SDK expects answers to be
      // returned via updatedInput.answers (keyed by question text).
      // ------------------------------------------------------------------
      if (toolName === "AskUserQuestion") {
        return question(input, options, signal)
      }

      // ------------------------------------------------------------------
      // ExitPlanMode: ask the user which agent to switch to and create a
      // synthetic user message so the main loop picks up the new agent.
      // ------------------------------------------------------------------
      if (toolName === "ExitPlanMode") {
        return exitPlanMode(options, signal)
      }

      const rawPatterns = extractPatterns(toolName, input)
      const permission = derivePermissionName(toolName)
      const requestID = PermissionID.ascending()

      // Gate 1: external_directory check for file-based tools outside the
      // project boundary — mirrors assertExternalDirectoryEffect in the
      // standard tool path.
      const filePath = extractFilePath(toolName, input)
      if (filePath) {
        const denied = await checkExternalDirectory(filePath, options, signal)
        if (denied) {
          const denyMsg = denied.behavior === "deny" ? (denied.message ?? "Permission denied") : "Permission denied"
          await markToolDenied(options.messageID, callOptions.toolUseID, denyMsg)
          return denied
        }
      }

      // Gate 2: tool-specific permission check.
      // Normalise file-based patterns to relative paths so the same
      // permission rules work in both the Claude SDK and standard tool paths.
      const patterns = normaliseFilePatterns(toolName, rawPatterns)
      log.info("canUseTool: permission check", { toolName, permission, patterns, rawPatterns, rulesetLength: options.ruleset?.length ?? 0 })

      // Generate diff metadata for edit/write tools
      const diffInfo = await generateEditDiff(toolName, input)
      const metadata: Record<string, unknown> = {
        toolName,
        title: callOptions.title,
        // Present only for subagent tool calls (the SDK's `ask` path re-routes
        // subagent requests through canUseTool with agentID set). Lets the TUI
        // label the prompt as coming from a subagent rather than the main agent.
        ...(callOptions.agentID ? { agentID: callOptions.agentID } : {}),
      }
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
          AppRuntime.runPromise(Permission.Service.use((svc) => svc.ask({
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
          }))),
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
          AppRuntime.runPromise(Permission.Service.use((svc) => svc.reply({ requestID, reply: "reject" }))).catch(() => {})
        }

        const msg =
          error instanceof Permission.RejectedError || error instanceof Permission.CorrectedError
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
    },
  )
}
