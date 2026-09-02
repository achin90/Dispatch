/**
 * Mirrors opencode sessions to claude.ai/code (and the Claude mobile app) via
 * the Claude Agent SDK's alpha `/bridge` export.
 *
 * The CLI's own `claude remote-control` refuses to run when ANTHROPIC_BASE_URL
 * points anywhere other than api.anthropic.com — a client-side precondition in
 * the interactive REPL (its gate even states that
 * _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL does not apply). The bridge API
 * takes `baseUrl` and an OAuth bearer as explicit arguments and never reads
 * ANTHROPIC_BASE_URL, so a local inference proxy is irrelevant to it: the
 * bridge is a separate control-plane connection straight to Anthropic.
 *
 * The attachment is bidirectional: messages typed on claude.ai or the phone
 * arrive via onInboundMessage and are submitted through SessionPrompt exactly
 * as an HTTP prompt would be, so the normal turn machinery runs and its output
 * streams back out.
 *
 * Remote prompts always run as the yolo agent, whose "*": "allow" ruleset
 * means the SDK runs tools without consulting canUseTool at all, so a prompt
 * typed on the phone never blocks on an approval. Local turns are unaffected
 * and keep prompting normally — and while a mirror is live their prompts are
 * additionally fanned out to claude.ai via askPermission(), so either surface
 * can answer.
 *
 * Attachments are cached per session and deliberately outlive a turn: closing
 * at each turn boundary is what makes claude.ai show the session as
 * "disconnected" between replies.
 *
 * ALPHA: breaking changes in `/bridge` do NOT bump the SDK's package major.
 *
 * Attaching is always explicit — the "Start remote session" palette command.
 * Turns consult getMirror() and stream to an attachment only if one exists, so
 * nothing is ever mirrored without the user asking for it.
 */

import type { BridgeSessionHandle, SessionState } from "@anthropic-ai/claude-agent-sdk/bridge"
import type { PermissionResult, SDKControlRequest, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Global } from "@opencode-ai/core/global"
import { MessageID, SessionID } from "./schema"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import * as Filesystem from "@/util/filesystem"
import * as LogBridge from "@/util/log-bridge"
import path from "path"

const log = LogBridge.create({ service: "claude-sdk-bridge" })

const BASE_URL = "https://api.anthropic.com"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const TIMEOUT_MS = 30_000

/** See the note on permissions above. */
const REMOTE_AGENT = "yolo"

/**
 * The claude.ai OAuth bearer the bridge authenticates with. This is the
 * subscription/OAuth credential the Claude CLI itself stores — distinct from
 * the inference API key resolveApiKey() returns, which the bridge cannot use.
 *
 * The `user:sessions:claude_code` scope is what gates bridge sessions
 * server-side.
 */
async function readOauthToken(): Promise<string | undefined> {
  const oauth = (await readCredentials())?.claudeAiOauth
  if (!oauth?.accessToken) {
    log.info("readOauthToken: no claudeAiOauth credential found — run `claude login`")
    return undefined
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    log.info("readOauthToken: credential expired", { expiresAt: oauth.expiresAt })
    return undefined
  }
  if (oauth.scopes && !oauth.scopes.includes("user:sessions:claude_code")) {
    log.info("readOauthToken: credential lacks user:sessions:claude_code scope", { scopes: oauth.scopes })
    return undefined
  }
  return oauth.accessToken
}

type Credentials = { claudeAiOauth?: { accessToken?: string; expiresAt?: number; scopes?: string[] } }

/**
 * The Claude CLI stores the credential differently per platform: Linux and
 * Windows write ~/.claude/.credentials.json, while macOS puts the same JSON in
 * the login Keychain and never writes that file.
 */
async function readCredentials(): Promise<Credentials | undefined> {
  const file = await Filesystem.readJson<Credentials>(
    path.join(Global.Path.home, ".claude", ".credentials.json"),
  ).catch(() => undefined)
  if (file) return file
  if (process.platform !== "darwin") return undefined
  const security = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const creds = await new Response(security.stdout).json().catch(() => undefined)
  if ((await security.exited) !== 0) {
    log.info("readCredentials: keychain lookup failed", { service: KEYCHAIN_SERVICE })
    return undefined
  }
  return creds as Credentials | undefined
}

/**
 * Maps opencode session IDs to claude.ai code-session IDs (`cse_*`), so a
 * session that spans several turns keeps one remote conversation instead of
 * creating a new one per prompt.
 */
const mapPath = () => path.join(Global.Path.state, "bridge-sessions.json")

async function readMap(): Promise<Record<string, string>> {
  const data = await Filesystem.readJson(mapPath()).catch(() => undefined)
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return data as Record<string, string>
}

async function rememberCodeSession(sessionID: string, codeSessionID: string): Promise<void> {
  await Filesystem.writeJson(mapPath(), { ...(await readMap()), [sessionID]: codeSessionID })
}

async function forgetCodeSession(sessionID: string): Promise<void> {
  const map = await readMap()
  delete map[sessionID]
  await Filesystem.writeJson(mapPath(), map)
}

export interface MirrorHandle {
  /** The claude.ai code session (`cse_*`) this is attached to. */
  codeSessionID: string
  /** Tee one SDKMessage to the remote transcript. */
  write(msg: SDKMessage): void
  /**
   * Mirror a locally-sent prompt. The SDK stream never echoes the user's own
   * message, so without this the remote transcript is assistant-only. Deduped
   * by messageID, since the run loop calls this once per step.
   */
  user(messageID: MessageID): void
  /** Turn boundary — stops the "working" spinner on claude.ai. */
  result(): void
  state(state: SessionState): void
  /**
   * Offer a permission prompt to claude.ai and resolve with the answer given
   * there. Never rejects, and never resolves at all when the bridge is dead or
   * nobody answers — callers must race this against the local prompt rather
   * than await it, and dismiss the loser with cancelPermission().
   */
  askPermission(req: SDKControlRequest): Promise<PermissionResult>
  /** Dismiss a prompt claude.ai is still showing. No-op once it was answered. */
  cancelPermission(requestID: string): void
  /** Drain the write queue — writes are batched, not sent per call. */
  flush(): Promise<void>
  close(): Promise<void>
}

export interface AttachMirrorInput {
  sessionID: SessionID
  /** Shown as the session title on claude.ai. */
  title: string
  cwd: string
  model?: string
}

const attached = new Map<string, MirrorHandle>()

/**
 * Resolvers for permission prompts forwarded to claude.ai, keyed by control
 * request id. onPermissionResponse is wired once per attachment but a resolver
 * exists per prompt, so the correlation cannot live in the handle's closure.
 * Request ids are permission request ids, already unique process-wide.
 */
const pendingPermissions = new Map<string, (result: PermissionResult) => void>()

/**
 * Interpreters for questions awaiting an answer, keyed by session. Registered
 * by the AskUserQuestion bridge — which owns the matching rules, since it is
 * the side that knows the options — and consulted by onInboundMessage before
 * text typed on claude.ai is submitted as a new prompt. A set per session
 * because a subagent can have its own question open alongside the main thread.
 */
const pendingQuestions = new Map<string, Set<(text: string) => boolean>>()

/**
 * Offers text typed on claude.ai to a pending question first. Returns an
 * unregister function; the caller must call it once the question is resolved,
 * so later messages go back to being ordinary prompts.
 */
export function registerRemoteQuestion(sessionID: SessionID, answer: (text: string) => boolean): () => void {
  const handlers = pendingQuestions.get(sessionID) ?? new Set<(text: string) => boolean>()
  pendingQuestions.set(sessionID, handlers)
  handlers.add(answer)
  return () => {
    handlers.delete(answer)
    if (handlers.size === 0) pendingQuestions.delete(sessionID)
  }
}

/** The live attachment for a session, if one was started. */
export function getMirror(sessionID: SessionID): MirrorHandle | undefined {
  return attached.get(sessionID)
}

/** Sessions with a live attachment, for surfacing remote state in the UI. */
export function mirroredSessions(): string[] {
  return [...attached.keys()]
}

/**
 * Detaches the session, so it stops mirroring and stops accepting remote
 * prompts. Returns false when nothing was attached. The claude.ai session
 * itself is left in place and stays mapped, so starting again resumes the same
 * remote conversation rather than opening a second one.
 */
export async function detachMirror(sessionID: SessionID, options?: { forget?: boolean }): Promise<boolean> {
  // Forgetting is for a session that no longer exists. Stopping normally keeps
  // the mapping so starting again resumes the same remote conversation.
  if (options?.forget) await forgetCodeSession(sessionID)
  const mirror = attached.get(sessionID)
  if (!mirror) return false
  await mirror.close()
  log.info("detachMirror: stopped mirroring", { sessionID, codeSessionID: mirror.codeSessionID })
  return true
}

/** Write one stored user message to the remote transcript. */
async function writeUserMessage(sessionID: SessionID, messageID: MessageID, mirror: MirrorHandle) {
  const { MessageV2 } = await import("./message-v2")
  const parts = await AppRuntime.runPromise(MessageV2.parts(messageID)).catch(() => [])
  const text = parts
    .flatMap((p) => (p.type === "text" && p.text.trim() !== "" ? [p.text] : []))
    .join("\n\n")
  if (!text) return
  mirror.write({
    type: "user",
    parent_tool_use_id: null,
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SDKMessage)
  log.info("attachMirror: mirrored local prompt", { sessionID, messageID })
}

/**
 * Replays the session's existing messages so the remote transcript opens with
 * the conversation so far rather than empty. Text only: tool calls are reduced
 * to a one-line note, since a faithful tool_use/tool_result replay would have
 * to reconstruct block ids the SDK never gave us.
 */
async function backfill(sessionID: SessionID, mirror: MirrorHandle, model?: string): Promise<void> {
  const { MessageV2 } = await import("./message-v2")
  const history = await AppRuntime.runPromise(MessageV2.stream(sessionID)).catch(() => [])
  let written = 0
  // stream() returns newest-first, and the remote transcript is append-only.
  for (const msg of history.toReversed()) {
    const text = msg.parts
      .filter((p): p is typeof p & { type: "text"; text: string } => p.type === "text" && p.text.trim() !== "")
      .map((p) => p.text)
      .join("\n\n")
    const tools = msg.parts.filter((p) => p.type === "tool").map((p) => (p as { tool: string }).tool)
    const body = [text, tools.length > 0 ? `_[ran ${tools.join(", ")}]_` : ""].filter(Boolean).join("\n\n")
    if (!body) continue
    mirror.write(
      (msg.info.role === "user"
        ? {
            type: "user",
            parent_tool_use_id: null,
            session_id: "",
            message: { role: "user", content: [{ type: "text", text: body }] },
          }
        : {
            type: "assistant",
            parent_tool_use_id: null,
            session_id: "",
            message: {
              id: msg.info.id,
              type: "message",
              role: "assistant",
              model: model ?? "unknown",
              content: [{ type: "text", text: body }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }) as unknown as SDKMessage,
    )
    written++
  }
  log.info("attachMirror: backfilled transcript", { sessionID, messages: written })
}

/**
 * Creates (or re-attaches to) the claude.ai code session mirroring this
 * opencode session. Returns undefined when mirroring is unavailable — a
 * missing credential, a denied org policy, or any transport failure. Mirroring
 * is strictly best-effort: a failure here must never break the local turn.
 */
export async function attachMirror(input: AttachMirrorInput): Promise<MirrorHandle | undefined> {
  const cached = attached.get(input.sessionID)
  if (cached) return cached

  const token = await readOauthToken()
  if (!token) return undefined

  const { attachBridgeSession, createCodeSession, fetchRemoteCredentials, isCreateSessionFailure, isCredentialsFailure, isCredentialsRejection } =
    await import("@anthropic-ai/claude-agent-sdk/bridge")

  const existing = (await readMap())[input.sessionID]
  const codeSessionID = await (async () => {
    if (existing) return existing
    const created = await createCodeSession(
      BASE_URL,
      token,
      input.title,
      TIMEOUT_MS,
      ["opencode"],
      undefined,
      input.cwd,
      input.model,
    )
    if (typeof created !== "string") {
      // A malformed_response create SUCCEEDED server-side, so retrying would
      // orphan a session per attempt — surface and give up either way.
      log.error("attachMirror: createCodeSession failed", {
        terminal: isCreateSessionFailure(created) || isCredentialsRejection(created),
        detail: created === null ? "transient" : JSON.stringify(created),
      })
      return undefined
    }
    await rememberCodeSession(input.sessionID, created)
    return created
  })()
  if (!codeSessionID) return undefined

  const creds = await fetchRemoteCredentials(codeSessionID, BASE_URL, token, TIMEOUT_MS)
  if (creds === null || isCredentialsFailure(creds) || isCredentialsRejection(creds)) {
    // A stale mapping (session deleted server-side) surfaces here as a
    // rejection — drop it so the next turn creates a fresh session.
    if (existing) await forgetCodeSession(input.sessionID)
    log.error("attachMirror: fetchRemoteCredentials failed", {
      codeSessionID,
      detail: creds === null ? "transient" : JSON.stringify(creds),
    })
    return undefined
  }

  // Prompts typed on claude.ai are already in the remote transcript before we
  // ever see them, so mirroring the user message the turn creates for them
  // would show the text twice. Minting the id here lets user() recognize it.
  const remoteOrigin = new Set<string>()

  const handle: BridgeSessionHandle = await attachBridgeSession({
    sessionId: codeSessionID,
    ingressToken: creds.worker_jwt,
    apiBaseUrl: creds.api_base_url,
    // fetchRemoteCredentials IS the worker register and bumps epoch, so pass
    // it through rather than letting the transport register again.
    epoch: creds.worker_epoch,
    // Instance.bind: AppRuntime resolves the owning instance from the ALS
    // context, which an SSE callback would otherwise re-enter without.
    onInboundMessage: Instance.bind(async (msg: SDKMessage) => {
      if (msg.type !== "user") return
      const content = (msg as { message?: { content?: unknown } }).message?.content
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
                .map((b) => b.text)
                .join("\n")
            : ""
      if (!text.trim()) return
      // A question is waiting: the reply answers it rather than starting a new
      // turn. Handlers reject text that matches none of their options, which
      // falls through to the prompt below.
      for (const answer of pendingQuestions.get(input.sessionID) ?? []) {
        if (!answer(text)) continue
        log.info("attachMirror: inbound answered a pending question", { sessionID: input.sessionID })
        return
      }
      log.info("attachMirror: inbound prompt", { sessionID: input.sessionID, length: text.length })
      const { SessionPrompt } = await import("./prompt")
      const messageID = MessageID.ascending()
      remoteOrigin.add(messageID)
      await AppRuntime.runPromise(
        SessionPrompt.Service.use((svc) =>
          svc.prompt({ sessionID: input.sessionID, messageID, agent: REMOTE_AGENT, parts: [{ type: "text", text }] }),
        ),
      ).catch((err) => {
        remoteOrigin.delete(messageID)
        log.error("attachMirror: inbound prompt failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }),
    onPermissionResponse: (res) => {
      const resolve = pendingPermissions.get(res.response.request_id)
      // Nothing waiting: either this process never sent that prompt, or the
      // TUI already answered it. Rejecting keeps it eligible for initialize
      // re-delivery rather than silently swallowing someone else's answer.
      if (!resolve) return false
      pendingPermissions.delete(res.response.request_id)
      log.info("attachMirror: remote permission answer", {
        sessionID: input.sessionID,
        requestID: res.response.request_id,
        subtype: res.response.subtype,
      })
      if (res.response.subtype === "error") {
        resolve({ behavior: "deny", message: res.response.error })
        return
      }
      const payload = res.response.response ?? {}
      resolve(
        payload.behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: typeof payload.message === "string" ? payload.message : "Denied on claude.ai" },
      )
    },
    onInterrupt: Instance.bind(async () => {
      log.info("attachMirror: inbound interrupt", { sessionID: input.sessionID })
      const { SessionPrompt } = await import("./prompt")
      await AppRuntime.runPromise(
        SessionPrompt.Service.use((svc) => svc.cancel(input.sessionID)),
      ).catch(() => {})
    }),
    onClose: (code) => {
      attached.delete(input.sessionID)
      log.info("attachMirror: bridge closed", { codeSessionID, code })
    },
  })

  log.info("attachMirror: mirroring session", { sessionID: input.sessionID, codeSessionID })
  handle.reportMetadata({ cwd: input.cwd })

  // Mirroring is cosmetic: a dead transport must never surface as a failed
  // local turn, so every call into the handle is swallowed.
  const safe = (op: string, fn: () => void) => {
    try {
      fn()
    } catch (err) {
      log.error(`attachMirror: ${op} failed`, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // The run loop calls user() once per step; only the first write is real.
  let lastUserWritten: string | undefined

  const mirror: MirrorHandle = {
    codeSessionID,
    write: (msg) => safe("write", () => handle.write(msg)),
    user: (messageID) => {
      if (lastUserWritten === messageID) return
      lastUserWritten = messageID
      // Came from claude.ai; echoing it back would duplicate it there.
      if (remoteOrigin.delete(messageID)) return
      void writeUserMessage(input.sessionID, messageID, mirror)
    },
    result: () => safe("sendResult", () => handle.sendResult()),
    state: (state) => safe("reportState", () => handle.reportState(state)),
    askPermission: (req) =>
      new Promise((resolve) => {
        pendingPermissions.set(req.request_id, resolve)
        // A throw here leaves the promise pending forever by design: the local
        // prompt is racing it and must still be able to win.
        safe("sendControlRequest", () => handle.sendControlRequest(req))
      }),
    cancelPermission: (requestID) => {
      // Already answered on claude.ai — there is nothing left to dismiss.
      if (!pendingPermissions.delete(requestID)) return
      safe("sendControlCancelRequest", () => handle.sendControlCancelRequest(requestID))
    },
    flush: () => handle.flush().catch(() => {}),
    close: async () => {
      attached.delete(input.sessionID)
      await handle.flush().catch(() => {})
      safe("close", () => handle.close())
    },
  }
  attached.set(input.sessionID, mirror)

  await backfill(input.sessionID, mirror, input.model)
  // write() only enqueues, and the uploader batches (100 per batch) on a
  // timer, so without draining here the tail of the transcript sits in the
  // queue and the remote UI shows a conversation that stops partway.
  await mirror.flush()
  // Without a result the remote UI sits on a "working" spinner for a session
  // that is in fact idle and waiting for input.
  mirror.result()
  mirror.state("idle")

  return mirror
}
