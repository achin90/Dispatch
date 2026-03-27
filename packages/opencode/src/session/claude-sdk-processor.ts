/**
 * Processor that consumes the Claude Agent SDK's query() output (async generator of SDKMessage)
 * and maps it into MessageV2 parts persisted via Session.updatePart/updateMessage.
 *
 * This replaces the existing SessionProcessor.process() + LLM.stream() path
 * when using the Claude Agent SDK instead of the Vercel AI SDK.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { popPendingMeta } from "./claude-sdk-permissions"
import {
  assistantMessageToParts,
  resultMessageToMetadata,
  type CompletionMetadata,
} from "./claude-sdk-adapter"
import { setSdkSessionID } from "./claude-sdk-session-map"
import { SessionStatus } from "./status"

// ---------------------------------------------------------------------------
// Activity formatting
// ---------------------------------------------------------------------------

function formatActivity(part: MessageV2.ToolPart): string {
  const name = part.tool.charAt(0).toUpperCase() + part.tool.slice(1)
  const input = part.state.input as Record<string, unknown> | undefined
  if (!input) return name
  const detail =
    (input.filePath as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.prompt as string) ??
    (input.description as string)
  if (!detail) return name
  const short = detail.includes("/") ? detail.split("/").pop()! : detail
  return `${name} ${short}`
}

// ---------------------------------------------------------------------------
// SDK task system message types
// ---------------------------------------------------------------------------
// The SDK sends these with type: "system" but different subtypes.
// TypeScript narrows the switch on msg.type to SDKSystemMessage (subtype: "init" only),
// so we define local interfaces matching the SDK's actual types.

interface SDKTaskStartedMessage {
  type: "system"
  subtype: "task_started"
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  prompt?: string
  uuid: string
  session_id: string
}

interface SDKTaskProgressMessage {
  type: "system"
  subtype: "task_progress"
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}

interface SDKTaskNotificationMessage {
  type: "system"
  subtype: "task_notification"
  task_id: string
  tool_use_id?: string
  status: "completed" | "failed" | "stopped"
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  uuid: string
  session_id: string
}

export interface ClaudeSdkProcessorInput {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  abort: AbortSignal
}

export interface ClaudeSdkProcessorResult {
  outcome: "stop" | "error"
  metadata?: CompletionMetadata
}

interface SubagentContext {
  childSessionID: SessionID
  childMessageID: MessageID
  userMessageID: MessageID
}

/**
 * Process a stream of SDKMessage from the Agent SDK's query() function.
 *
 * For each AssistantMessage: maps content blocks to MessageV2 parts and persists them.
 * For the ResultMessage: finalizes the assistant message with cost/token metadata.
 * Routes subagent messages to child sessions via parent_tool_use_id.
 *
 * The SDK owns tool execution — it never sends us tool-result events. Before
 * processing a new assistant message (which means previous tools finished),
 * we finalize any "running" tool parts so spinners stop and the TUI can
 * collapse them.
 */
export async function processClaudeSdkStream(
  messages: AsyncIterable<SDKMessage>,
  input: ClaudeSdkProcessorInput,
): Promise<ClaudeSdkProcessorResult> {
  const { assistantMessage, sessionID } = input
  let completionMeta: CompletionMetadata | undefined
  const subagentMap = new Map<string, SubagentContext>()

  try {
    for await (const msg of messages) {
      if (input.abort.aborted) break

      switch (msg.type) {
        case "assistant":
          await processAssistantMessage(
            msg as SDKAssistantMessage,
            sessionID,
            assistantMessage,
            subagentMap,
          )
          break

        case "result":
          // All tools must be complete before the result — finalize stragglers.
          await finalizeRunningTools(assistantMessage.id)
          completionMeta = processResultMessage(
            msg as SDKResultMessage,
            assistantMessage,
          )
          await Session.updateMessage(assistantMessage)
          break

        case "system": {
          // The SDK sends multiple system subtypes (init, task_started, task_progress,
          // task_notification) all with type: "system". TypeScript narrows to SDKSystemMessage
          // which only has subtype: "init", so we cast to access subtype as a string.
          const sysMsg = msg as SDKSystemMessage
          const subtype = sysMsg.subtype as string

          if (subtype === "init") {
            await setSdkSessionID(sessionID, sysMsg.session_id)
          } else if (subtype === "task_started") {
            await handleTaskStarted(msg as unknown as SDKTaskStartedMessage, sessionID, assistantMessage, subagentMap)
          } else if (subtype === "task_progress") {
            await handleTaskProgress(msg as unknown as SDKTaskProgressMessage, assistantMessage)
          } else if (subtype === "task_notification") {
            await handleTaskNotification(msg as unknown as SDKTaskNotificationMessage, assistantMessage, subagentMap)
          }
          break
        }

        // user, stream_event, etc. — ignored
        default:
          break
      }
    }
  } catch (error) {
    // The SDK throws when the abort signal fires (e.g. user presses Esc).
    // This is expected — treat it as a clean abort, not an unhandled error.
    if (input.abort.aborted) {
      // Fall through to the abort handling below
    } else {
      throw error
    }
  }

  // If we exited without a result message (e.g. abort), mark pending tools as errors
  if (!completionMeta) {
    await abortRunningTools(assistantMessage.id)
    // Also abort running tools in child sessions
    for (const ctx of Array.from(subagentMap.values())) {
      await abortRunningTools(ctx.childMessageID)
    }
    assistantMessage.time.completed = Date.now()
    assistantMessage.error = {
      name: "MessageAbortedError",
      data: { message: "Stream ended without result" },
    } as MessageV2.Assistant["error"]
    await Session.updateMessage(assistantMessage)
    return { outcome: "error" }
  }

  return {
    outcome: completionMeta.success ? "stop" : "error",
    metadata: completionMeta,
  }
}

/**
 * Mark all "running" tool parts as "completed". Called before processing a new
 * assistant message or result, since the SDK wouldn't proceed if tools were
 * still running.
 */
async function finalizeRunningTools(messageID: MessageID): Promise<void> {
  const parts = await MessageV2.parts(messageID)
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "running") continue
    // Merge any pending metadata stashed by canUseTool (e.g. diffs for
    // edit/write tools). The pending map handles the race where canUseTool
    // runs before processAssistantMessage creates the ToolPart.
    const merged = {
      ...(part.state.metadata ?? {}),
      ...popPendingMeta(part.callID),
    }
    await Session.updatePart({
      ...part,
      state: {
        status: "completed",
        input: part.state.input,
        output: "",
        title: part.state.title ?? "",
        metadata: merged,
        time: {
          start: part.state.time.start,
          end: Date.now(),
        },
      },
    })
  }
}

/**
 * Mark all "running" tool parts as "error" on abort/unexpected exit.
 */
async function abortRunningTools(messageID: MessageID): Promise<void> {
  const parts = await MessageV2.parts(messageID)
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "running") continue
    await Session.updatePart({
      ...part,
      state: {
        status: "error",
        input: part.state.input,
        error: "Tool execution aborted",
        time: {
          start: part.state.time.start,
          end: Date.now(),
        },
      },
    })
  }
}

/**
 * Maps an SDKAssistantMessage's content blocks to MessageV2 parts and persists each one.
 * If the message has a parent_tool_use_id, it belongs to a subagent and is routed to
 * the appropriate child session.
 */
async function processAssistantMessage(
  msg: SDKAssistantMessage,
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  subagentMap: Map<string, SubagentContext>,
): Promise<void> {
  if (msg.parent_tool_use_id === null) {
    // Top-level message — finalize running tools then persist parts
    await finalizeRunningTools(assistantMessage.id)
    const parts = assistantMessageToParts(msg, sessionID, assistantMessage.id)
    for (const part of parts) {
      await Session.updatePart(part)
    }
    // Update activity based on the last meaningful part
    const tool = parts.findLast((p) => p.type === "tool")
    const activity = tool ? formatActivity(tool) : "Thinking..."
    await SessionStatus.set(sessionID, { type: "busy", activity })
    return
  }

  // Subagent message — route to child session
  const parentToolUseId = msg.parent_tool_use_id
  let ctx = subagentMap.get(parentToolUseId)

  if (!ctx) {
    // First message from this subagent — create child session (task_started hasn't arrived yet)
    ctx = await createChildSession(sessionID, assistantMessage, parentToolUseId)
    subagentMap.set(parentToolUseId, ctx)
  } else {
    // Subsequent turn — previous tools in child session must be complete
    await finalizeRunningTools(ctx.childMessageID)
  }

  const parts = assistantMessageToParts(msg, ctx.childSessionID, ctx.childMessageID)
  for (const part of parts) {
    await Session.updatePart(part)
  }
}

/**
 * Resolve the agent name from a tool part's input.
 * The SDK sends subagentType as PascalCase (e.g., "Explore") but opencode
 * agents use lowercase names (e.g., "explore") for color/display matching.
 */
function resolveAgentName(toolPart: MessageV2.ToolPart | undefined, fallback?: string): string {
  const raw = (toolPart?.state.input?.subagentType as string | undefined) ?? fallback
  return raw?.toLowerCase() ?? "default"
}

/**
 * Create a child session for a subagent and wire it up to the parent Agent ToolPart.
 * Creates a user message (with the prompt) and an assistant message, mirroring
 * the structure the old task tool creates via SessionPrompt.prompt().
 */
async function createChildSession(
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  parentToolUseId: string,
  overrideAgentName?: string,
): Promise<SubagentContext> {
  // Find the Agent ToolPart's description/prompt from its input to use as title
  const parentParts = await MessageV2.parts(assistantMessage.id)
  const agentPart = parentParts.find(
    (p: MessageV2.Part): p is MessageV2.ToolPart => p.type === "tool" && p.callID === parentToolUseId,
  )
  const description = agentPart?.state.input?.description as string | undefined
  const prompt = agentPart?.state.input?.prompt as string | undefined
  const agentName = resolveAgentName(agentPart, overrideAgentName)

  const childSession = await Session.create({
    parentID: sessionID,
    title: description ? `${description} (@${agentName} subagent)` : "Subagent",
  })

  // Create a user message with the prompt text (matches old task tool pattern)
  const userMessageID = MessageID.ascending()
  const userMessage: MessageV2.User = {
    id: userMessageID,
    sessionID: childSession.id,
    role: "user",
    time: { created: Date.now() },
    agent: agentName,
    model: {
      providerID: assistantMessage.providerID,
      modelID: assistantMessage.modelID,
    },
  }
  await Session.updateMessage(userMessage)

  // Create text part for the user message with the prompt
  if (prompt) {
    await Session.updatePart({
      id: PartID.ascending(),
      sessionID: childSession.id,
      messageID: userMessageID,
      type: "text",
      text: prompt,
      time: { start: Date.now(), end: Date.now() },
    })
  }

  // Create an assistant message linked to the user message
  const childMessageID = MessageID.ascending()
  const childMessage: MessageV2.Assistant = {
    id: childMessageID,
    sessionID: childSession.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: userMessageID,
    modelID: assistantMessage.modelID,
    providerID: assistantMessage.providerID,
    mode: agentName,
    agent: agentName,
    path: assistantMessage.path,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await Session.updateMessage(childMessage)

  // Update the parent Agent ToolPart's metadata with the child session ID
  if (agentPart) {
    await updateAgentToolMetadata(agentPart, childSession.id)
  }

  return { childSessionID: childSession.id, childMessageID, userMessageID }
}

/**
 * Update an Agent ToolPart's state.metadata with the child session ID,
 * which is the bridge that makes the TUI Task component work.
 */
async function updateAgentToolMetadata(
  agentPart: MessageV2.ToolPart,
  childSessionID: SessionID,
): Promise<void> {
  if (agentPart.state.status !== "running") return
  await Session.updatePart({
    ...agentPart,
    state: {
      ...agentPart.state,
      metadata: {
        ...(agentPart.state.metadata ?? {}),
        sessionId: childSessionID,
      },
    },
  })
}

/**
 * Handle task_started: eagerly create child session if not yet created,
 * update title and Agent ToolPart state.
 */
async function handleTaskStarted(
  msg: SDKTaskStartedMessage,
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  subagentMap: Map<string, SubagentContext>,
): Promise<void> {
  const toolUseId = msg.tool_use_id
  if (!toolUseId) return

  // task_type is a generic classification (e.g., "local_agent"), not the agent name.
  // The actual agent name comes from the tool input's subagentType field.
  // We pass task_type as a fallback for createChildSession.
  const taskTypeFallback = msg.task_type ?? "default"

  let ctx = subagentMap.get(toolUseId)
  if (!ctx) {
    ctx = await createChildSession(sessionID, assistantMessage, toolUseId, taskTypeFallback)
    subagentMap.set(toolUseId, ctx)
  }

  // Resolve the correct agent name for the title
  const parentParts = await MessageV2.parts(assistantMessage.id)
  const agentPart = parentParts.find(
    (p: MessageV2.Part): p is MessageV2.ToolPart => p.type === "tool" && p.callID === toolUseId,
  )
  const agentName = resolveAgentName(agentPart, taskTypeFallback)

  // Update the child session title with the description and correct agent name
  if (msg.description) {
    await Session.setTitle({
      sessionID: ctx.childSessionID,
      title: `${msg.description} (@${agentName} subagent)`,
    })
  }

  // Update the Agent ToolPart's title
  if (agentPart && agentPart.state.status === "running") {
    await Session.updatePart({
      ...agentPart,
      state: {
        ...agentPart.state,
        title: msg.description,
        metadata: {
          ...(agentPart.state.metadata ?? {}),
          sessionId: ctx.childSessionID,
        },
      },
    })
  }
}

/**
 * Handle task_progress: update the Agent ToolPart's metadata with tool count for live display.
 */
async function handleTaskProgress(
  msg: SDKTaskProgressMessage,
  assistantMessage: MessageV2.Assistant,
): Promise<void> {
  const toolUseId = msg.tool_use_id
  if (!toolUseId) return

  const parentParts = await MessageV2.parts(assistantMessage.id)
  const agentPart = parentParts.find(
    (p: MessageV2.Part): p is MessageV2.ToolPart => p.type === "tool" && p.callID === toolUseId,
  )
  if (agentPart && agentPart.state.status === "running") {
    await Session.updatePart({
      ...agentPart,
      state: {
        ...agentPart.state,
        title: msg.description ?? agentPart.state.title,
        metadata: {
          ...(agentPart.state.metadata ?? {}),
          toolUses: msg.usage.tool_uses,
          lastToolName: msg.last_tool_name,
        },
      },
    })
  }
}

/**
 * Handle task_notification: finalize child session tools and mark Agent ToolPart as completed/error.
 */
async function handleTaskNotification(
  msg: SDKTaskNotificationMessage,
  assistantMessage: MessageV2.Assistant,
  subagentMap: Map<string, SubagentContext>,
): Promise<void> {
  const toolUseId = msg.tool_use_id
  if (!toolUseId) return

  const ctx = subagentMap.get(toolUseId)
  if (ctx) {
    await finalizeRunningTools(ctx.childMessageID)
  }

  const parentParts = await MessageV2.parts(assistantMessage.id)
  const agentPart = parentParts.find(
    (p: MessageV2.Part): p is MessageV2.ToolPart => p.type === "tool" && p.callID === toolUseId,
  )
  if (!agentPart || agentPart.state.status !== "running") return

  if (msg.status === "completed") {
    await Session.updatePart({
      ...agentPart,
      state: {
        status: "completed",
        input: agentPart.state.input,
        output: msg.summary ?? "",
        title: agentPart.state.title ?? "",
        metadata: agentPart.state.metadata ?? {},
        time: {
          start: agentPart.state.time.start,
          end: Date.now(),
        },
      },
    })
  } else {
    // failed or stopped
    await Session.updatePart({
      ...agentPart,
      state: {
        status: "error",
        input: agentPart.state.input,
        error: msg.summary ?? `Task ${msg.status}`,
        metadata: agentPart.state.metadata,
        time: {
          start: agentPart.state.time.start,
          end: Date.now(),
        },
      },
    })
  }
}

/**
 * Extracts completion metadata from SDKResultMessage and updates the assistant message.
 * Mutates the assistantMessage in place (same pattern as existing processor).
 */
function processResultMessage(
  msg: SDKResultMessage,
  assistantMessage: MessageV2.Assistant,
): CompletionMetadata {
  const meta = resultMessageToMetadata(msg)

  assistantMessage.time.completed = Date.now()
  assistantMessage.cost = meta.total_cost_usd
  assistantMessage.tokens = {
    input: meta.tokens.input,
    output: meta.tokens.output,
    reasoning: 0,
    cache: {
      read: meta.tokens.cache_read,
      write: meta.tokens.cache_write,
    },
  }

  if (!meta.success) {
    assistantMessage.error = {
      name: "APIError",
      data: {
        message: meta.errors?.join("; ") ?? "Unknown error",
        isRetryable: false,
      },
    } as MessageV2.Assistant["error"]
  }

  assistantMessage.finish = meta.stop_reason ?? "end_turn"

  return meta
}
