export * as DispatchRunner from "./node.js"

import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { FileAccess } from "@opencode/core/file-access"
import { Form } from "@opencode/core/form"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { LocationLifecycle } from "@opencode/core/location-lifecycle"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { StepFailedError } from "@opencode/core/session/error"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { DrainResult, SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTitle } from "@opencode/core/session/title"
import { Tool } from "@opencode/core/tool"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, Fiber, FiberMap, Layer, Stream } from "effect"
import { DispatchBridge } from "../bridge/service.js"
import { DispatchBridgeRpc } from "../bridge/rpc.js"
import { SdkAdapter } from "../sdk/adapter.js"
import { SdkBin } from "../sdk/bin.js"
import { SdkEnv } from "../sdk/env.js"
import { SdkModels } from "../sdk/models.js"
import { SdkSessionMap } from "../sdk/session-map.js"
import { SdkMcp } from "./mcp.js"
import { SdkPermission } from "./permission.js"
import { SdkQuery } from "./query.js"
import { SdkRouter } from "./router.js"

// A fresh identity for the stock runner: the replacement map keys on node identity, so depending
// on SessionRunnerLLM.node itself would resolve back to this node.
const stock = SessionRunnerLLM.node.mapLayer((layer) => layer)

/**
 * Replaces the Location's SessionRunner: Sessions on an Anthropic model run through the Claude
 * Agent SDK, every other Session through the stock runner. The SDK owns the tool loop, so one
 * drain turn is one `query()` that may span many provider calls (see packages/dispatch/AGENTS.md).
 */
const layer = Layer.effect(
  SessionRunner.Service,
  Effect.gen(function* () {
    const inner = yield* SessionRunner.Service
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const db = (yield* Database.Service).db
    const plugins = yield* Plugin.Service
    const title = yield* SessionTitle.Service
    const sessions = yield* Session.Service
    const models = yield* Model.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const integrations = yield* Integration.Service
    // SDK callbacks (canUseTool, hooks, MCP handlers) run outside any fiber; they re-enter this
    // Location through the context captured here, never through ambient state.
    const services = yield* Effect.context<SdkPermission.Requirements | Mcp.Service | Session.Service>()
    const run = <A, E>(
      effect: Effect.Effect<A, E, SdkPermission.Requirements | Mcp.Service | Session.Service>,
      signal?: AbortSignal,
    ) => Effect.runPromiseWith(services)(effect, signal ? { signal } : undefined)
    const mcp = SdkMcp.make(yield* Mcp.Service, yield* Tool.Service, yield* Agent.Service)
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()
    // Dispatch bridge: claude.ai mirroring (process-wide; see bridge/service.ts).
    const bridge = yield* DispatchBridge.Service

    const drain = Effect.fn("DispatchRunner.drain")(function* (input: Parameters<SessionRunner.Interface["drain"]>[0]) {
      const session = yield* store.get(input.sessionID)
      const resolved = session
        ? yield* context.resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      if (!resolved || !SdkModels.isSdkModel(resolved.ref)) return yield* inner.drain(input)
      return yield* drainSdk(input)
    })

    /** Owns the inbox like the stock runner, but one turn is one SDK query and steers wait for the next. */
    const drainSdk = Effect.fn("DispatchRunner.drainSdk")(function* (
      input: Parameters<SessionRunner.Interface["drain"]>[0],
    ) {
      const sessionID = input.sessionID
      const scope = input.promotable ?? "input"
      let force = input.force || input.continuation !== undefined
      if (!force && !(yield* SessionInbox.nextPromotable(db, sessionID, scope))) return DrainResult.Complete()
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)
      while (true) {
        if (lifecycle.isClosed()) return DrainResult.Reloaded({ force })
        const next = yield* SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            const item = yield* SessionInbox.nextPromotable(db, sessionID, scope)
            if (item?.type === "compaction")
              yield* bus.publishAll([
                [SessionEvent.InboxDelivered, { sessionID, inboxID: item.id }],
                [SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID: item.id }],
              ])
            if (item?.type === "move")
              yield* bus.publishAll([
                [SessionEvent.InboxDelivered, { sessionID, inboxID: item.id }],
                [SessionEvent.Moved, { sessionID, ...item.payload }],
              ])
            return item
          }),
        )
        if (next?.type === "move") return DrainResult.Moved({})
        if (next?.type === "compaction") {
          yield* compact(sessionID, next.id)
          force = false
          continue
        }
        if (!next && !force) return DrainResult.Complete()
        const selected = yield* context.select(sessionID)
        // A blocked initial instruction baseline must leave admitted input pending.
        yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
        const promoted = yield* SessionInbox.promote(db, bus, sessionID, scope)
        // A control admitted during preparation owns this boundary.
        if (promoted === undefined) continue
        if (promoted === 0 && !force) return DrainResult.Complete()
        force = false
        if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
          yield* FiberMap.run(titles, sessionID, title.generate(sessionID), { onlyIfMissing: true })
        yield* turn(yield* context.load(selected), selected)
      }
    })

    /** One SDK query answering every Session message since the last reply. */
    const turn = Effect.fn("DispatchRunner.turn")(function* (
      loaded: SessionContext.Loaded,
      selected: SessionContext.Selection,
    ) {
      const pending = SdkQuery.pending(loaded.messages)
      if (pending.length === 0) return
      const prompt = SdkQuery.prompt(pending)
      const entry = SdkSessionMap.read(loaded.session)
      const outcome = yield* attempt(loaded, selected, prompt, entry)
      if (outcome !== "stale" || !entry) return
      yield* Effect.logWarning("stale Claude Agent SDK session; retrying without resume", {
        sessionID: loaded.session.id,
        uuid: entry.uuid,
      })
      yield* SdkSessionMap.remove(loaded.session.id).pipe(
        Effect.provideService(Session.Service, sessions),
        Effect.orDie,
      )
      yield* attempt(loaded, selected, prompt, undefined)
    })

    const attempt = Effect.fn("DispatchRunner.attempt")(function* (
      loaded: SessionContext.Loaded,
      selected: SessionContext.Selection,
      prompt: ReturnType<typeof SdkQuery.prompt>,
      resume: SdkSessionMap.Entry | undefined,
    ) {
      const session = loaded.session
      const info = yield* models.get(loaded.model.ref.providerID, loaded.model.ref.id)
      const cwd = resume?.cwd ?? location.directory
      const abortController = new AbortController()
      const directory = SdkPermission.directory()
      const metadata = new Map<string, Tool.Metadata>()
      const compaction: { summary?: string } = {}
      const declined = { value: false }
      const permissions = {
        sessionID: session.id,
        agent: loaded.agent.id,
        run,
        directory,
        metadata,
        onDecline: () => {
          declined.value = true
        },
        // Dispatch bridge: permission prompts and questions fan out to a claude.ai mirror.
        remote: bridge,
      }
      // Dispatch bridge: tees this query to the Session's claude.ai mirror while one is attached.
      const mirror = bridge.turn(session.id)
      const router = SdkRouter.make({
        bus,
        sessionID: session.id,
        agent: loaded.agent.id,
        model: loaded.model.ref,
        cost: loaded.model.cost,
        directory,
        metadata,
        createChild: (child) => createChild(session, child),
        onInit: (uuid) =>
          Effect.logInfo("claude agent sdk session", {
            sessionID: session.id,
            uuid,
            resumed: resume?.uuid === uuid,
          }).pipe(
            Effect.andThen(SdkSessionMap.write(session.id, { uuid, cwd })),
            Effect.provideService(Session.Service, sessions),
            Effect.catchCause((cause) => Effect.logWarning("failed to record SDK session", { cause })),
          ),
        compactSummary: () => compaction.summary,
        declined: () => declined.value,
      })
      const options = SdkQuery.options({
        model: SdkModels.cliModel(info?.modelID ?? loaded.model.ref.id),
        systemPrompt: yield* systemPrompt(selected),
        cwd,
        resume: resume?.uuid,
        apiKey: yield* SdkEnv.apiKey(integrations),
        effort: loaded.model.ref.variant,
        contextWindow: loaded.model.limit.context,
        advisorModel: yield* advisor(),
        abortController,
        canUseTool: SdkPermission.canUseTool(permissions),
        preToolUse: SdkPermission.subagentHook(permissions),
        postCompact: capture(compaction),
        mcpServers: {
          ...(yield* mcp.servers((effect) => run(effect))),
          ...(yield* mcp.plugins(
            (effect, signal) => run(effect, signal),
            { sessionID: session.id, agent: loaded.agent.id },
            {
              lookup: (toolUseID) => directory.lookup(toolUseID),
              progress: router.progress,
              metadata,
              signal: abortController.signal,
              onDecline: permissions.onDecline,
              agent: () =>
                run(SdkPermission.currentAgent(session.id, loaded.agent.id)).catch(() => loaded.agent.id),
            },
          )),
        },
        pathToClaudeCodeExecutable: yield* Effect.promise(() => SdkBin.resolveClaudeBin()),
      })
      yield* Effect.logInfo("starting claude agent sdk query", {
        sessionID: session.id,
        model: options.model,
        resume: resume?.uuid,
        cwd,
        mcpServers: Object.keys(options.mcpServers ?? {}),
        systemPromptChars: typeof options.systemPrompt === "string" ? options.systemPrompt.length : undefined,
      })
      const stream = yield* Effect.sync(() => query({ prompt: SdkQuery.input(prompt), options }))
      yield* mirror.prompted(SdkQuery.pending(loaded.messages)) // Dispatch bridge
      const consuming = yield* Stream.fromAsyncIterable(stream as AsyncIterable<SDKMessage>, (error) => error).pipe(
        Stream.runForEach((message) => mirror.frame(message).pipe(Effect.andThen(router.handle(message)))), // Dispatch bridge: tee
        // Detached so an interrupted drain does not wait for this fiber's cleanup, below.
        Effect.forkDetach({ startImmediately: true }),
      )
      const consumed = yield* Fiber.join(consuming).pipe(
        // Interrupting the drain aborts the CLI and settles every open message as interrupted, without
        // waiting for the stream to close: its iterator's return() waits about two seconds for the
        // aborted CLI process to exit. Once interrupted, the stream handles no further frames.
        Effect.onInterrupt(() =>
          Effect.sync(() => abortController.abort()).pipe(
            Effect.andThen(Fiber.interrupt(consuming).pipe(Effect.forkDetach({ startImmediately: true }))),
            Effect.andThen(router.abort(INTERRUPTED, true)),
          ),
        ),
        // Dispatch bridge: ends the remote turn on every path (result, error, interrupt).
        Effect.ensuring(Effect.suspend(() => mirror.settle(router.result()?.is_error === false))),
        Effect.exit,
      )
      if (Exit.isFailure(consumed) && Cause.hasInterruptsOnly(consumed.cause)) return yield* Effect.interrupt
      // A decline without feedback ends the step as interrupted, as it does on the stock runner.
      if (declined.value) {
        yield* router.abort(INTERRUPTED, true)
        return yield* Effect.interrupt
      }
      const result = router.result()
      // The CLI also throws after an error result; the result carries the useful message.
      const failure = Exit.isFailure(consumed) && !result ? Cause.squash(consumed.cause) : undefined
      const message =
        failure !== undefined
          ? SdkAdapter.errorMessage(failure)
          : result
            ? resultError(result)
            : "The Claude Agent SDK ended without a result"
      if (message === undefined) return "done" as const
      // A resume the CLI cannot find fails before any output; the caller retries without it.
      if (resume && !router.outputStarted() && SdkQuery.isStaleResume(message)) return "stale" as const
      const error = failure !== undefined ? toSessionError(failure) : { type: "provider.unknown", message }
      // An error result after output already failed its message; anything else still needs one.
      if (failure !== undefined || !result || !router.outputStarted()) yield* router.abort(error, false)
      return yield* new StepFailedError({ error })
    })

    /** Subagent output goes to a child Session so the subagents tab and navigation work natively. */
    const createChild = (parent: SessionSchema.Info, input: { readonly title: string; readonly prompt: string }) =>
      Effect.gen(function* () {
        // Explicit metadata: children inherit the parent's by default, including its SDK session uuid.
        const child = yield* sessions.create({ parentID: parent.id, title: input.title, metadata: {} })
        if (input.prompt) {
          yield* sessions.prompt({ sessionID: child.id, text: input.prompt, resume: false })
          yield* SessionInbox.promote(db, bus, child.id, "input")
        }
        return { sessionID: child.id, agent: child.agent ?? parent.agent ?? Agent.ID.make("build") }
      }).pipe(Effect.orDie)

    /** Agent system prompt plus instructions. The CLI supplies its own environment block. */
    const systemPrompt = Effect.fn("DispatchRunner.systemPrompt")(function* (selected: SessionContext.Selection) {
      const sources = selected.instructions.filter((source) => !InstructionBuiltIns.sdkSkipped.has(source.key))
      const values = Object.fromEntries(
        (yield* Instructions.read(sources)).flatMap((entry) =>
          entry.value === Instructions.unavailable || entry.value === Instructions.removed
            ? []
            : [[entry.key, entry.value] as const],
        ),
      )
      return [selected.agent.info.system, Instructions.renderInitial(sources, values)]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n")
    })

    /** Config `advisor` (e.g. "opus"); "off" or unset disables. Read per turn so a change applies live. */
    const advisor = Effect.fn("DispatchRunner.advisor")(function* () {
      const value = Config.latest(yield* config.entries(), "advisor")
      return value && value !== "off" ? value : undefined
    })

    /** Manual compaction: `/compact` on the resumed SDK session, recorded as a v2 Compaction message. */
    const compact = Effect.fn("DispatchRunner.compact")(function* (
      sessionID: SessionSchema.ID,
      inputID: SessionMessage.ID,
    ) {
      const session = yield* store.get(sessionID)
      const entry = session ? SdkSessionMap.read(session) : undefined
      const failed = (message: string) =>
        bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: "manual",
          inputID,
          error: { type: "compaction.failed", message },
        })
      if (!session || !entry) return yield* failed("There is no Claude Agent SDK conversation to compact yet")
      const loaded = yield* context.load(yield* context.select(sessionID))
      const info = yield* models.get(loaded.model.ref.providerID, loaded.model.ref.id)
      const compaction: { summary?: string } = {}
      const abortController = new AbortController()
      const directory = SdkPermission.directory()
      const permissions = { sessionID, agent: loaded.agent.id, run, directory, metadata: new Map() }
      const stream = query({
        prompt: "/compact",
        options: SdkQuery.options({
          model: SdkModels.cliModel(info?.modelID ?? loaded.model.ref.id),
          systemPrompt: "",
          cwd: entry.cwd,
          resume: entry.uuid,
          apiKey: yield* SdkEnv.apiKey(integrations),
          contextWindow: loaded.model.limit.context,
          abortController,
          canUseTool: SdkPermission.canUseTool(permissions),
          preToolUse: SdkPermission.subagentHook(permissions),
          postCompact: capture(compaction),
          mcpServers: {},
          maxTurns: 1,
          pathToClaudeCodeExecutable: yield* Effect.promise(() => SdkBin.resolveClaudeBin()),
        }),
      })
      const boundary = yield* Stream.fromAsyncIterable(stream as AsyncIterable<SDKMessage>, (error) => error).pipe(
        Stream.filter((message) => message.type === "system" && message.subtype === "compact_boundary"),
        Stream.runHead,
        Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
        Effect.exit,
      )
      abortController.abort()
      if (Exit.isFailure(boundary) || boundary.value._tag === "None") {
        yield* SdkSessionMap.remove(sessionID).pipe(Effect.provideService(Session.Service, sessions), Effect.orDie)
        return yield* failed(
          Exit.isFailure(boundary) ? SdkAdapter.errorMessage(Cause.squash(boundary.cause)) : "The SDK did not compact",
        )
      }
      for (let waited = 0; compaction.summary === undefined && waited < 3_000; waited += 50) yield* Effect.sleep(50)
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        model: loaded.model.ref,
        text: compaction.summary ?? "The conversation was compacted by the Claude Agent SDK.",
      })
    })

    // Copied from the stock runner (not exported): a process death skips compaction finalizers.
    const settleStaleCompactions = Effect.fn("DispatchRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    // Copied from the stock runner (not exported): tools left running by a dead process settle as aborted.
    const settleStaleToolCalls = Effect.fn("DispatchRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return SessionRunner.Service.of({ drain })
  }),
)

const INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const

const resultError = (result: ReturnType<SdkRouter.Router["result"]>) => {
  if (!result?.is_error) return undefined
  if ("errors" in result && result.errors.length > 0) return result.errors.join("; ")
  return "result" in result ? result.result : "The Claude Agent SDK reported an error"
}

/** PostCompact hook: keeps the summary for the Compaction message. */
const capture =
  (target: { summary?: string }): HookCallback =>
  async (input) => {
    if (input.hook_event_name === "PostCompact") target.summary = input.compact_summary
    return { continue: true }
  }

export const node = makeLocationNode({
  service: SessionRunner.Service,
  layer,
  deps: [
    stock,
    Agent.node,
    Bus.node,
    Config.node,
    Database.node,
    FileAccess.node,
    Form.node,
    Integration.node,
    Location.node,
    LocationLifecycle.node,
    Mcp.node,
    Model.node,
    Permission.node,
    PermissionSaved.node,
    Plugin.node,
    Session.node,
    SessionContext.node,
    SessionStore.node,
    SessionTitle.node,
    Tool.node,
    // Dispatch bridge: the mirror service, and its RPC registered in every Location.
    DispatchBridge.node,
    DispatchBridgeRpc.node,
  ],
})

export const replacements: LayerNode.Replacements = [SessionRunnerLLM.node.replace(node)]
