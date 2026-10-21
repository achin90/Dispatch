export * as BridgeMirror from "./mirror.js"

import type { PermissionResult, SDKControlRequest, SDKControlResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { BridgeSessionHandle, SessionState } from "@anthropic-ai/claude-agent-sdk/bridge"
import type { SessionMessage } from "@opencode/core/session/message"
import type { SessionSchema } from "@opencode/core/session/schema"

/** The part of the SDK's bridge handle a mirror drives. */
export type Transport = Pick<
  BridgeSessionHandle,
  "write" | "sendResult" | "reportState" | "sendControlRequest" | "sendControlCancelRequest" | "flush" | "close"
>

export type Log = (message: string, fields?: Record<string, unknown>) => void

export interface MirrorHandle {
  readonly sessionID: SessionSchema.ID
  /** The claude.ai code session (`cse_*`) this is attached to. */
  readonly codeSessionID: string
  /** Tee one SDK frame to the remote transcript. */
  write(message: SDKMessage): void
  /**
   * Mirror locally sent prompts. The SDK stream never echoes the user's own message, so without
   * this the remote transcript is assistant-only. Skips prompts typed on claude.ai (already there)
   * and prompts already written, by backfill or by an earlier attempt of the same turn.
   */
  user(messages: ReadonlyArray<{ readonly id: SessionMessage.ID; readonly text: string }>): void
  /**
   * Turn boundary: stops claude.ai's "working" spinner. `mark` is the newest message the turn
   * completed; it is persisted so a later attach does not backfill it again. Omit it after an abort
   * or an error, where the transcript was only partly mirrored.
   */
  result(mark?: SessionMessage.ID): void
  state(state: SessionState): void
  /**
   * Offer a permission prompt to claude.ai and resolve with the answer given there. Never rejects,
   * and never resolves when the bridge is dead or nobody answers: callers must not await it alone,
   * and dismiss it with `cancelPermission` once the prompt is settled.
   */
  askPermission(request: SDKControlRequest): Promise<PermissionResult>
  /** Dismiss a prompt claude.ai is still showing. No-op once it was answered there. */
  cancelPermission(requestID: string): void
  /** Records a prompt that came from claude.ai, so `user` does not echo it back. */
  remote(messageID: SessionMessage.ID): void
  /** Forgets a remote prompt that was never admitted. */
  unremote(messageID: SessionMessage.ID): void
  /** Records messages already in the remote transcript. */
  covered(messageIDs: Iterable<SessionMessage.ID>): void
  /** Drain the write queue: writes are batched, not sent per call. */
  flush(): Promise<void>
  close(): Promise<void>
}

/** Live attachments, by Session. Attachments deliberately outlive a turn (see bridge/service.ts). */
const attached = new Map<string, MirrorHandle>()

/**
 * Resolvers for permission prompts forwarded to claude.ai, keyed by control request id (the
 * Permission request id, unique process-wide). The response callback is wired once per attachment
 * while a resolver exists per prompt, so the correlation cannot live in one handle's closure.
 */
const pendingPermissions = new Map<string, (result: PermissionResult) => void>()

/**
 * Interpreters for questions awaiting an answer, keyed by Session, consulted before text typed on
 * claude.ai becomes a prompt. A set because a subagent can have a question open alongside the
 * main thread.
 */
const pendingQuestions = new Map<string, Set<(text: string) => boolean>>()

/** The live attachment for a Session, if one was started. */
export function getMirror(sessionID: string): MirrorHandle | undefined {
  return attached.get(sessionID)
}

/** Sessions with a live attachment. */
export function mirroredSessions(): string[] {
  return [...attached.keys()]
}

export function publish(mirror: MirrorHandle) {
  attached.set(mirror.sessionID, mirror)
}

/** Drops the attachment, unless a newer handle already replaced it. */
export function unpublish(mirror: MirrorHandle) {
  if (attached.get(mirror.sessionID) === mirror) attached.delete(mirror.sessionID)
}

/**
 * Offers text typed on claude.ai to a pending question first. The returned function unregisters
 * it; call it once the question is settled so later messages are prompts again.
 */
export function registerRemoteQuestion(sessionID: string, answer: (text: string) => boolean) {
  const handlers = pendingQuestions.get(sessionID) ?? new Set<(text: string) => boolean>()
  pendingQuestions.set(sessionID, handlers)
  handlers.add(answer)
  return () => {
    handlers.delete(answer)
    if (handlers.size === 0 && pendingQuestions.get(sessionID) === handlers) pendingQuestions.delete(sessionID)
  }
}

/** Whether a pending question consumed the text. Handlers reject text that answers nothing. */
export function offerAnswer(sessionID: string, text: string) {
  return [...(pendingQuestions.get(sessionID) ?? [])].some((answer) => answer(text))
}

/**
 * Routes a `control_response` from claude.ai to the prompt that asked. Returns false when nothing
 * is waiting (this process never sent it, or it was answered locally), which keeps the answer
 * eligible for re-delivery instead of swallowing it.
 */
export function respond(response: SDKControlResponse, log?: Log) {
  const resolve = pendingPermissions.get(response.response.request_id)
  if (!resolve) return false
  pendingPermissions.delete(response.response.request_id)
  log?.("remote permission answer", { requestID: response.response.request_id, subtype: response.response.subtype })
  if (response.response.subtype === "error") {
    resolve({ behavior: "deny", message: response.response.error })
    return true
  }
  const payload = response.response.response ?? {}
  resolve(
    payload.behavior === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: typeof payload.message === "string" ? payload.message : "" },
  )
  return true
}

/**
 * Wraps a bridge handle. Mirroring is cosmetic, so every call into the transport goes through
 * `safe()`: a dead transport must never surface as a failed local turn.
 */
export function make(
  transport: Transport,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly codeSessionID: string
    readonly mark?: SessionMessage.ID
    readonly log: Log
    /** Persists a new high-water mark. */
    readonly persist: (mark: SessionMessage.ID) => void
  },
): MirrorHandle {
  const safe = (operation: string, fn: () => void) => {
    try {
      fn()
    } catch (error) {
      input.log(`mirror ${operation} failed`, {
        sessionID: input.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const remote = new Set<string>()
  const written = new Set<string>()
  let mark = input.mark

  const mirror: MirrorHandle = {
    sessionID: input.sessionID,
    codeSessionID: input.codeSessionID,
    write: (message) => safe("write", () => transport.write(message)),
    user: (messages) => {
      for (const message of messages) {
        if (written.has(message.id)) continue
        written.add(message.id)
        if (remote.delete(message.id)) continue
        if (message.text.trim() === "") continue
        mirror.write(userFrame(message.text))
      }
    },
    result: (next) => {
      safe("sendResult", () => transport.sendResult())
      if (!next || next === mark) return
      mark = next
      input.persist(next)
    },
    state: (state) => safe("reportState", () => transport.reportState(state)),
    askPermission: (request) =>
      new Promise((resolve) => {
        pendingPermissions.set(request.request_id, resolve)
        // A throw leaves this pending forever by design: the local prompt must still be able to win.
        safe("sendControlRequest", () => transport.sendControlRequest(request))
      }),
    cancelPermission: (requestID) => {
      if (!pendingPermissions.delete(requestID)) return
      safe("sendControlCancelRequest", () => transport.sendControlCancelRequest(requestID))
    },
    remote: (messageID) => {
      remote.add(messageID)
    },
    unremote: (messageID) => {
      remote.delete(messageID)
    },
    covered: (messageIDs) => {
      for (const id of messageIDs) written.add(id)
    },
    flush: () => {
      try {
        return transport.flush().catch(() => undefined)
      } catch {
        return Promise.resolve()
      }
    },
    close: async () => {
      unpublish(mirror)
      await mirror.flush()
      safe("close", () => transport.close())
    },
  }
  return mirror
}

/**
 * A user frame for the remote transcript. The SDK only echo-suppresses frames carrying a uuid (it
 * remembers the uuids it sent), so every frame gets one. `historical` renders replayed history as
 * history rather than a burst of new activity.
 */
export function userFrame(text: string, options: { readonly historical?: boolean } = {}) {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    ...(options.historical ? { historical: true } : {}),
    parent_tool_use_id: null,
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SDKMessage
}

export function assistantFrame(
  text: string,
  options: { readonly id: string; readonly model?: string; readonly historical?: boolean },
) {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    ...(options.historical ? { historical: true } : {}),
    parent_tool_use_id: null,
    session_id: "",
    message: {
      id: options.id,
      type: "message",
      role: "assistant",
      model: options.model ?? "unknown",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage
}
