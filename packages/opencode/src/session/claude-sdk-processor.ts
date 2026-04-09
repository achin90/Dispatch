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
import { assistantMessageToParts, resultMessageToMetadata, type CompletionMetadata } from "./claude-sdk-adapter"
import { setSdkSessionID } from "./claude-sdk-session-map"
import { SessionStatus } from "./status"
import { SessionCompaction } from "./compaction"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const status =
      (error as unknown as Record<string, unknown>).status ?? (error as unknown as Record<string, unknown>).statusCode
    if (status === 500 || String(status) === "500") return "Claude internal server error"
    if (typeof status === "number" && status >= 500) return `Claude server error (${status})`
    return error.message || "Unknown error"
  }
  if (typeof error === "string") return error
  return "Unknown error"
}

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

interface SDKCompactBoundary {
  type: "system"
  subtype: "compact_boundary"
  compact_metadata: {
    trigger: "manual" | "auto"
    pre_tokens: number
  }
  uuid: string
  session_id: string
}

export interface CompactionRef {
  summary?: string
}

export interface ClaudeSdkProcessorInput {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  abort: AbortSignal
  compaction?: CompactionRef
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
 */
export async function processClaudeSdkStream(
  messages: AsyncIterable<SDKMessage>,
  input: ClaudeSdkProcessorInput,
): Promise<ClaudeSdkProcessorResult> {
  const { assistantMessage, sessionID } = input
  let completionMeta: CompletionMetadata | undefined
  const subagentMap = new Map<string, SubagentContext>()
  let lastTurnUsage:
    | {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
    | undefined

  try {
    for await (const msg of messages) {
      if (input.abort.aborted) break

      switch (msg.type) {
        case "assistant": {
          const assistant = msg as SDKAssistantMessage
          if (assistant.parent_tool_use_id === null) {
            lastTurnUsage = assistant.message.usage
          }
          await processAssistantMessage(assistant, sessionID, assistantMessage, subagentMap)
          break
        }

        case "result":
          await finalizeRunningTools(assistantMessage.id)
          completionMeta = processResultMessage(msg as SDKResultMessage, assistantMessage, lastTurnUsage)
          await Session.updateMessage(assistantMessage)
          break

        case "system": {
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
          } else if (subtype === "compact_boundary") {
            await handleCompactBoundary(
              msg as unknown as SDKCompactBoundary,
              sessionID,
              assistantMessage,
              input.compaction,
            )
          }
          break
        }

        default:
          break
      }
    }
  } catch (error) {
    if (!input.abort.aborted) {
      await abortRunningTools(assistantMessage.id)
      for (const ctx of Array.from(subagentMap.values())) {
        await abortRunningTools(ctx.childMessageID)
      }
      const msg = extractErrorMessage(error)
      assistantMessage.time.completed = Date.now()
      assistantMessage.error = {
        name: "APIError",
        data: { message: msg, isRetryable: true },
      } as MessageV2.Assistant["error"]
      await Session.updateMessage(assistantMessage)
      return { outcome: "error" }
    }
  }

  if (!completionMeta) {
    await abortRunningTools(assistantMessage.id)
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

async function finalizeRunningTools(messageID: MessageID): Promise<void> {
  const parts = await MessageV2.parts(messageID)
  for (const part of parts) {
    if (part.type !== "tool" || part.state.status !== "running") continue
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

async function processAssistantMessage(
  msg: SDKAssistantMessage,
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  subagentMap: Map<string, SubagentContext>,
): Promise<void> {
  if (msg.parent_tool_use_id === null) {
    await finalizeRunningTools(assistantMessage.id)
    const parts = assistantMessageToParts(msg, sessionID, assistantMessage.id)
    for (const part of parts) {
      await Session.updatePart(part)
    }
    const tool = parts.findLast((p) => p.type === "tool")
    const activity = tool ? formatActivity(tool) : "Thinking..."
    await SessionStatus.set(sessionID, { type: "busy", activity } as any)
    return
  }

  const parentToolUseId = msg.parent_tool_use_id
  let ctx = subagentMap.get(parentToolUseId)

  if (!ctx) {
    ctx = await createChildSession(sessionID, assistantMessage, parentToolUseId)
    subagentMap.set(parentToolUseId, ctx)
  } else {
    await finalizeRunningTools(ctx.childMessageID)
  }

  const parts = assistantMessageToParts(msg, ctx.childSessionID, ctx.childMessageID)
  for (const part of parts) {
    await Session.updatePart(part)
  }
}

function resolveAgentName(toolPart: MessageV2.ToolPart | undefined, fallback?: string): string {
  const raw = (toolPart?.state.input?.subagentType as string | undefined) ?? fallback
  return raw?.toLowerCase() ?? "default"
}

async function createChildSession(
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  parentToolUseId: string,
  overrideAgentName?: string,
): Promise<SubagentContext> {
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

  if (agentPart) {
    await updateAgentToolMetadata(agentPart, childSession.id)
  }

  return { childSessionID: childSession.id, childMessageID, userMessageID }
}

async function updateAgentToolMetadata(agentPart: MessageV2.ToolPart, childSessionID: SessionID): Promise<void> {
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

async function handleTaskStarted(
  msg: SDKTaskStartedMessage,
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  subagentMap: Map<string, SubagentContext>,
): Promise<void> {
  const toolUseId = msg.tool_use_id
  if (!toolUseId) return

  const taskTypeFallback = msg.task_type ?? "default"

  let ctx = subagentMap.get(toolUseId)
  if (!ctx) {
    ctx = await createChildSession(sessionID, assistantMessage, toolUseId, taskTypeFallback)
    subagentMap.set(toolUseId, ctx)
  }

  const parentParts = await MessageV2.parts(assistantMessage.id)
  const agentPart = parentParts.find(
    (p: MessageV2.Part): p is MessageV2.ToolPart => p.type === "tool" && p.callID === toolUseId,
  )
  const agentName = resolveAgentName(agentPart, taskTypeFallback)

  if (msg.description) {
    await Session.setTitle({
      sessionID: ctx.childSessionID,
      title: `${msg.description} (@${agentName} subagent)`,
    })
  }

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

async function handleTaskProgress(msg: SDKTaskProgressMessage, assistantMessage: MessageV2.Assistant): Promise<void> {
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

function processResultMessage(
  msg: SDKResultMessage,
  assistantMessage: MessageV2.Assistant,
  lastTurnUsage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  },
): CompletionMetadata {
  const meta = resultMessageToMetadata(msg)

  const context = lastTurnUsage
    ? lastTurnUsage.input_tokens +
      (lastTurnUsage.cache_read_input_tokens ?? 0) +
      (lastTurnUsage.cache_creation_input_tokens ?? 0) +
      (lastTurnUsage.output_tokens ?? 0)
    : undefined

  assistantMessage.time.completed = Date.now()
  assistantMessage.cost = meta.total_cost_usd
  assistantMessage.tokens = {
    ...(context !== undefined ? { total: context } : {}),
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

async function handleCompactBoundary(
  msg: SDKCompactBoundary,
  sessionID: SessionID,
  assistantMessage: MessageV2.Assistant,
  ref?: CompactionRef,
): Promise<void> {
  const summary = ref?.summary ?? "Conversation was compacted by the Claude SDK."

  const userMsg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent: assistantMessage.agent,
    model: {
      providerID: assistantMessage.providerID,
      modelID: assistantMessage.modelID,
    },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: userMsg.id,
    sessionID,
    type: "compaction",
    auto: msg.compact_metadata.trigger === "auto",
  })

  const session = await Session.get(sessionID)
  const reply = (await Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: userMsg.id,
    sessionID,
    mode: "compaction",
    agent: "compaction",
    summary: true,
    path: {
      cwd: session.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: assistantMessage.modelID,
    providerID: assistantMessage.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "end_turn",
  })) as MessageV2.Assistant

  await Session.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "text",
    text: summary,
    time: { start: Date.now(), end: Date.now() },
  })

  Bus.publish(SessionCompaction.Event.Compacted, { sessionID })
}
