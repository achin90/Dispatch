export * as DispatchBridge from "./service.js"

import type { SDKControlRequest, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AttachBridgeSessionOptions } from "@anthropic-ai/claude-agent-sdk/bridge"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/core/form"
import { Instance } from "@opencode/core/instance/service"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTitle } from "@opencode/core/session/title"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import path from "node:path"
import type { SdkAdapter } from "../sdk/adapter.js"
import { SdkModels } from "../sdk/models.js"
import { BridgeBackfill } from "./backfill.js"
import { BridgeCredentials } from "./credentials.js"
import { BridgeMapping } from "./mapping.js"
import { BridgeMirror } from "./mirror.js"
import { BridgeQuestion } from "./question.js"

/**
 * Mirrors Sessions to claude.ai/code (and the Claude mobile app) through the Claude Agent SDK's
 * alpha `/bridge` export. ALPHA: breaking changes there do not bump the SDK's major version.
 *
 * The bridge takes its base URL and an OAuth bearer explicitly and never reads
 * ANTHROPIC_BASE_URL, so it works behind a local inference proxy, which `claude remote-control`
 * refuses to do. It is a separate control-plane connection straight to Anthropic.
 *
 * Attaching is always explicit (the `dispatch-bridge` RPC). Turns look the mirror up per SDK frame
 * and stream to it only when one exists, so a mirror started mid-turn picks the turn up from
 * wherever it is. Attachments outlive a turn: closing at each turn boundary is what makes claude.ai
 * show the session as disconnected between replies.
 *
 * The attachment is bidirectional. Text typed on claude.ai answers a pending question or becomes a
 * prompt run as the `yolo` agent, so a prompt from the phone never blocks on an approval. Local
 * turns keep prompting normally, and while mirrored their permission prompts and questions are
 * also offered to claude.ai; whichever surface answers first wins.
 *
 * Every SDK callback runs outside any fiber and re-enters through the context this global layer
 * captured once. Mirroring is best-effort: no failure here may fail a local turn.
 */
export const BASE_URL = "https://api.anthropic.com"
export const REMOTE_AGENT = Agent.ID.make("yolo")
const TIMEOUT_MS = 30_000

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("DispatchBridge.UnavailableError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

type Sdk = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk/bridge"),
  "attachBridgeSession" | "createCodeSession" | "fetchRemoteCredentials" | "isCredentialsFailure"
>

/** External effects, injectable so tests never touch the network, the Keychain or the SDK. */
export interface Dependencies {
  readonly token: () => Promise<BridgeCredentials.Result>
  readonly sdk: () => Promise<Sdk>
}

export const defaults: Dependencies = {
  token: () => BridgeCredentials.read(),
  sdk: () => import("@anthropic-ai/claude-agent-sdk/bridge"),
}

/** Hooks one SDK turn of the runner into the mirror. */
export interface Turn {
  /** The user messages the turn answers, mirrored once the query exists. */
  readonly prompted: (messages: ReadonlyArray<SessionMessage.Info>) => Effect.Effect<void>
  /** One SDK frame, teed before the runner handles it. */
  readonly frame: (message: SDKMessage) => Effect.Effect<void>
  /** Turn end on every path. `completed` records the transcript as mirrored through it. */
  readonly settle: (completed: boolean) => Effect.Effect<void>
}

export interface PermissionInput {
  readonly sessionID: SessionSchema.ID
  /** The id the runner passes to `Permission.assert`; fan-out waits for its `permission.asked`. */
  readonly requestID: Permission.ID
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly toolUseID: string
  readonly agentID?: string
  /** Answers the pending request the way the TUI does (`Permission.reply`). */
  readonly reply: (answer: { readonly allow: boolean; readonly message?: string }) => Promise<unknown>
}

export interface QuestionInput {
  readonly sessionID: SessionSchema.ID
  /** The id the runner passes to `Form.ask`; fan-out waits for its `form.created`. */
  readonly formID: Form.ID
  readonly prompts: ReadonlyArray<SdkAdapter.Question>
  /** Answers the pending form the way the TUI does (`Form.reply`). */
  readonly reply: (answer: Form.Answer) => Promise<unknown>
}

/** The runner's remote fan-out. Each returns a cleanup to call once the prompt is settled. */
export interface Remote {
  readonly permission: (input: PermissionInput) => () => void
  readonly question: (input: QuestionInput) => () => void
}

export interface Interface extends Remote {
  /** Attaches (or re-attaches) the Session and returns its claude.ai code session id. */
  readonly attach: (sessionID: SessionSchema.ID) => Effect.Effect<string, UnavailableError | Session.NotFoundError>
  /**
   * Stops mirroring and remote prompts. The claude.ai session stays and stays mapped, so attaching
   * again resumes the same remote conversation; `forget` drops the mapping too.
   */
  readonly detach: (sessionID: SessionSchema.ID, options?: { readonly forget?: boolean }) => Effect.Effect<boolean>
  readonly list: () => string[]
  readonly turn: (sessionID: SessionSchema.ID) => Turn
}

export class Service extends Context.Service<Service, Interface>()("@opencode/dispatch/Bridge") {}

export const make = Effect.fn("DispatchBridge.make")(function* (dependencies: Dependencies) {
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  // Bridge callbacks run on the SDK's transport, outside any fiber: they re-enter through this.
  const context = yield* Effect.context<Session.Service | SessionStore.Service | Bus.Service>()
  const runFork = Effect.runForkWith(context)
  const runPromise = Effect.runPromiseWith(context)
  const runSync = Effect.runSyncWith(context)
  const log: BridgeMirror.Log = (message, fields) =>
    void runFork(Effect.logInfo(message, fields).pipe(Effect.annotateLogs("service", "dispatch-bridge")))
  // One attach at a time, so a double click never creates two remote sessions.
  const attaching = yield* Semaphore.make(1)
  // Metadata writes replace the whole record; serialize every read-modify-write.
  const writes = yield* Semaphore.make(1)
  const persist = (sessionID: SessionSchema.ID, entry: BridgeMapping.Entry | undefined) =>
    writes.withPermit(BridgeMapping.write(sessionID, entry)).pipe(
      Effect.provideService(Session.Service, sessions),
      Effect.catchCause((cause) => Effect.logWarning("failed to persist bridge mapping", { sessionID, cause })),
    )

  const attach = Effect.fn("DispatchBridge.attach")((sessionID: SessionSchema.ID) =>
    attaching.withPermit(
      Effect.gen(function* () {
        const cached = BridgeMirror.getMirror(sessionID)
        if (cached) return cached.codeSessionID
        const session = yield* sessions.get(sessionID)
        const token = yield* Effect.promise(() => dependencies.token())
        if ("reason" in token) return yield* new UnavailableError({ reason: token.reason })
        const sdk = yield* Effect.tryPromise({
          try: () => dependencies.sdk(),
          catch: () => new UnavailableError({ reason: "The Claude Agent SDK bridge is unavailable" }),
        })
        const existing = BridgeMapping.read(session)
        const cwd = session.location.directory
        const codeSessionID = existing?.codeSessionID ?? (yield* create(sdk, session, token.token))
        const credentials = yield* Effect.promise(() =>
          sdk.fetchRemoteCredentials(codeSessionID, BASE_URL, token.token, TIMEOUT_MS),
        )
        if (credentials === null || "terminal" in credentials) {
          // A null is transient (a restart blip is the common one) and an auth rejection says the
          // credential is bad, not the session: keep the mapping, or the remote session the phone
          // is attached to is orphaned. Only an authoritative rejection of the session drops it.
          if (sdk.isCredentialsFailure(credentials) && forgets(credentials))
            yield* persist(sessionID, undefined)
          return yield* new UnavailableError({
            reason: `claude.ai refused the session credentials (${credentials === null ? "transient failure, try again" : credentials.reason})`,
          })
        }
        const handle = yield* Effect.tryPromise({
          try: () =>
            sdk.attachBridgeSession(
              callbacks(sessionID, codeSessionID, {
                sessionId: codeSessionID,
                ingressToken: credentials.worker_jwt,
                apiBaseUrl: credentials.api_base_url,
                // fetchRemoteCredentials is the worker register and bumps the epoch; pass it through
                // rather than letting the transport register again.
                epoch: credentials.worker_epoch,
              }),
            ),
          catch: (error) =>
            new UnavailableError({
              reason: `Could not attach to claude.ai: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })
        yield* Effect.try(() => handle.reportMetadata({ cwd })).pipe(Effect.ignore)
        const mirror = BridgeMirror.make(handle, {
          sessionID,
          codeSessionID,
          mark: existing?.mark,
          log,
          persist: (mark) => void runFork(persist(sessionID, { codeSessionID, mark })),
        })
        const history = yield* store.messages({ sessionID, order: "asc" }).pipe(Effect.orElseSucceed(() => []))
        const replay = BridgeBackfill.select(history, existing?.mark)
        for (const entry of replay.entries)
          mirror.write(
            entry.role === "user"
              ? BridgeMirror.userFrame(entry.text, { historical: true })
              : BridgeMirror.assistantFrame(entry.text, { id: entry.id, model: session.model?.id, historical: true }),
          )
        // Covers the in-flight turn's prompt too, which the runner would otherwise mirror again.
        mirror.covered(history.map((message) => message.id))
        // Writes are queued and uploaded in batches; without draining, the remote transcript stops
        // partway. Without a result, claude.ai shows a spinner for a session that is idle.
        yield* Effect.promise(() => mirror.flush())
        mirror.result(replay.mark)
        mirror.state("idle")
        // Published last: a running turn resolves the mirror per frame, so publishing before the idle
        // above would let it report "running" and then be stomped back to idle mid-turn.
        BridgeMirror.publish(mirror)
        yield* Effect.logInfo("mirroring session to claude.ai", {
          sessionID,
          codeSessionID,
          backfilled: replay.entries.length,
        })
        return codeSessionID
      }),
    ),
  )

  const create = Effect.fn("DispatchBridge.create")(function* (sdk: Sdk, session: SessionSchema.Info, token: string) {
    // claude.ai cannot rename a session later, so a placeholder title becomes the directory name.
    const title =
      SessionTitle.isUntitled(session) || !session.title ? path.basename(session.location.directory) : session.title
    const created = yield* Effect.promise(() =>
      sdk.createCodeSession(
        BASE_URL,
        token,
        title,
        TIMEOUT_MS,
        ["opencode"],
        undefined,
        session.location.directory,
        session.model ? SdkModels.cliModel(session.model.id) : undefined,
      ),
    )
    // A malformed_response create succeeded server-side, so retrying would orphan a session per
    // attempt: surface it and give up either way.
    if (typeof created !== "string")
      return yield* new UnavailableError({
        reason: `claude.ai did not create a session (${created === null ? "transient failure, try again" : created.reason})`,
      })
    yield* persist(session.id, { codeSessionID: created })
    return created
  })

  /** The bridge's inbound callbacks, re-entering through the captured context. */
  const callbacks = (
    sessionID: SessionSchema.ID,
    codeSessionID: string,
    options: Pick<AttachBridgeSessionOptions, "sessionId" | "ingressToken" | "apiBaseUrl" | "epoch">,
  ): AttachBridgeSessionOptions => ({
    ...options,
    onInboundMessage: (message) => {
      const text = inboundText(message)
      if (!text.trim()) return
      // A reply to a pending question answers it instead of starting a turn.
      if (BridgeMirror.offerAnswer(sessionID, text)) return log("inbound answered a pending question", { sessionID })
      return runPromise(inbound(sessionID, text)).catch(() => undefined)
    },
    onPermissionResponse: (response) => BridgeMirror.respond(response, log),
    onInterrupt: () => {
      log("inbound interrupt", { sessionID })
      runFork(execution.interrupt(sessionID))
    },
    onClose: (code) => {
      const mirror = BridgeMirror.getMirror(sessionID)
      if (mirror?.codeSessionID === codeSessionID) BridgeMirror.unpublish(mirror)
      // 401 and 4094 need a fresh attach; nothing reconnects automatically.
      log("bridge closed", { sessionID, codeSessionID, code })
    },
  })

  /** A prompt typed on claude.ai, run as the remote agent. */
  const inbound = Effect.fn("DispatchBridge.inbound")(function* (sessionID: SessionSchema.ID, text: string) {
    const mirror = BridgeMirror.getMirror(sessionID)
    const messageID = SessionMessage.ID.create()
    // Already in the remote transcript; mirroring the user message it becomes would show it twice.
    mirror?.remote(messageID)
    yield* Effect.gen(function* () {
      const session = yield* sessions.get(sessionID)
      if (session.agent !== REMOTE_AGENT) {
        // Without the agent every tool call would be denied (missing agents get no permissions).
        const exists = yield* instances
          .provide(session)(
            Effect.gen(function* () {
              const agents = yield* Agent.Service
              return (yield* agents.resolve(REMOTE_AGENT)) !== undefined
            }),
          )
          .pipe(Effect.orElseSucceed(() => false))
        if (exists) yield* sessions.switchAgent({ sessionID, agent: REMOTE_AGENT })
        if (!exists) yield* Effect.logWarning("remote agent is not defined; prompting with the session's agent")
      }
      yield* sessions.prompt({ sessionID, id: messageID, text })
      yield* Effect.logInfo("inbound prompt", { sessionID, messageID, length: text.length })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => mirror?.unremote(messageID)).pipe(
          Effect.andThen(Effect.logError("inbound prompt failed", { sessionID, cause })),
        ),
      ),
    )
  })

  const detach = Effect.fn("DispatchBridge.detach")(function* (
    sessionID: SessionSchema.ID,
    options?: { readonly forget?: boolean },
  ) {
    if (options?.forget) yield* persist(sessionID, undefined)
    const mirror = BridgeMirror.getMirror(sessionID)
    if (!mirror) return false
    yield* Effect.promise(() => mirror.close())
    yield* Effect.logInfo("stopped mirroring", { sessionID, codeSessionID: mirror.codeSessionID })
    return true
  })

  const turn = (sessionID: SessionSchema.ID): Turn => {
    // Held by identity so a detach and re-attach mid-turn reports "running" on the new handle.
    let running: BridgeMirror.MirrorHandle | undefined
    let frames = 0
    return {
      prompted: (messages) =>
        Effect.sync(() =>
          BridgeMirror.getMirror(sessionID)?.user(
            messages.flatMap((message) => (message.type === "user" ? [{ id: message.id, text: message.text }] : [])),
          ),
        ),
      frame: (message) =>
        Effect.sync(() => {
          // One lookup per frame, so state and write cannot straddle a detach.
          const mirror = BridgeMirror.getMirror(sessionID)
          if (!mirror) return
          if (running !== mirror) {
            running = mirror
            mirror.state("running")
          }
          mirror.write(message)
          frames++
        }),
      settle: (completed) =>
        Effect.gen(function* () {
          const mirror = BridgeMirror.getMirror(sessionID)
          if (!mirror) return
          const [latest] = completed
            ? yield* store.messages({ sessionID, order: "desc", limit: 1 }).pipe(Effect.orElseSucceed(() => []))
            : []
          mirror.result(latest?.id)
          mirror.state("idle")
          // Logged once the upload drains, off the turn's path: a slow transport must not delay it.
          yield* Effect.promise(() => mirror.flush()).pipe(
            Effect.andThen(Effect.logInfo("mirrored turn uploaded", { sessionID, frames, completed, mark: latest?.id })),
            Effect.forkDetach,
          )
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to end the mirrored turn", { cause }))),
    }
  }

  const permission = (input: PermissionInput) => {
    const mirror = BridgeMirror.getMirror(input.sessionID)
    if (!mirror) return () => {}
    // Sent only once `permission.asked` fires for this request: an auto-allowed call never asks, and
    // sending eagerly would notify the phone about prompts that never appeared locally.
    let asked = false
    const unsubscribe = listen((event) => {
      if (asked || event.type !== Permission.Event.Asked.type) return
      if ((event.data as Permission.Request).id !== input.requestID) return
      asked = true
      void mirror
        .askPermission(controlRequest(input))
        // A remote updatedInput is ignored: claude.ai answers yes or no, it does not rewrite the call.
        .then((result) =>
          input.reply(
            result.behavior === "allow"
              ? { allow: true }
              : { allow: false, ...(result.message ? { message: result.message } : {}) },
          ),
        )
        .catch(() => undefined)
      // The documented signal that the session needs the user.
      mirror.state("requires_action")
    })
    return () => {
      unsubscribe()
      // Dismisses the loser, including on abort, where claude.ai would keep showing a dead prompt.
      if (!asked) return
      mirror.cancelPermission(input.requestID)
      mirror.state("running")
    }
  }

  const question = (input: QuestionInput) => {
    const mirror = BridgeMirror.getMirror(input.sessionID)
    if (!mirror || input.prompts.length === 0) return () => {}
    let unregister: (() => void) | undefined
    const ask = (at: number) => {
      mirror.write(
        BridgeMirror.assistantFrame(BridgeQuestion.render(input.prompts, at), { id: SessionMessage.ID.create() }),
      )
      // The result ends the remote turn: a session claude.ai believes is working shows a spinner
      // instead of the composer the answer is typed into.
      void mirror.flush().then(() => mirror.result())
    }
    // One pending form backs both surfaces: the remote answer goes through Form.reply, which
    // settles the very form the runner awaits, so the first answer wins outright.
    const unsubscribe = listen((event) => {
      if (unregister || event.type !== Form.Event.Created.type) return
      if ((event.data as { readonly form: Form.Info }).form.id !== input.formID) return
      unregister = BridgeMirror.registerRemoteQuestion(
        input.sessionID,
        BridgeQuestion.answerer(input.prompts, { ask, reply: (answer) => void input.reply(answer).catch(() => {}) }),
      )
      ask(0)
      mirror.state("requires_action")
    })
    return () => {
      unsubscribe()
      if (!unregister) return
      unregister()
      mirror.state("running")
    }
  }

  /** Registers synchronously, so an event published right after this returns is seen. */
  const listen = (listener: (event: Parameters<Bus.Subscriber>[0]) => void) => {
    const unsubscribe = runSync(bus.listen((event) => Effect.sync(() => listener(event))))
    return () => void runFork(unsubscribe)
  }

  // A deleted Session's mapping went with its row; only the live attachment is left to close.
  yield* Effect.acquireRelease(
    bus.listen((event) =>
      event.type === SessionEvent.Deleted.type
        ? detach((event.data as { readonly sessionID: SessionSchema.ID }).sessionID).pipe(
            Effect.forkDetach,
            Effect.asVoid,
          )
        : Effect.void,
    ),
    (unsubscribe) => unsubscribe,
  )
  // Shutdown closes live attachments; the mappings stay for the next process.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(BridgeMirror.mirroredSessions(), (sessionID) => detach(SessionSchema.ID.make(sessionID)), {
      discard: true,
    }),
  )

  return Service.of({ attach, detach, list: BridgeMirror.mirroredSessions, turn, permission, question })
})

/** Only an authoritative rejection of the session itself invalidates the mapping. */
function forgets(failure: { readonly reason: string }) {
  return failure.reason === "request_rejected" || failure.reason === "invalid_session_id"
}

function controlRequest(input: PermissionInput): SDKControlRequest {
  return {
    type: "control_request",
    request_id: input.requestID,
    request: {
      subtype: "can_use_tool",
      tool_name: input.toolName,
      input: input.input,
      tool_use_id: input.toolUseID,
      ...(input.agentID ? { agent_id: input.agentID } : {}),
    },
  }
}

function inboundText(message: SDKMessage) {
  if (message.type !== "user") return ""
  const content: unknown = message.message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block: unknown) =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block
        ? [String(block.text)]
        : [],
    )
    .join("\n")
}

export const layer = Layer.effect(Service, make(defaults))

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Instance.node, Session.node, SessionExecution.node, SessionStore.node],
})
