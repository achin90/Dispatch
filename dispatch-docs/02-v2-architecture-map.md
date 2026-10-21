# opencode v1 → v2 architecture map for porting the Dispatch fork (research report)

v2 is a full re-architecture. The fork's Claude Agent SDK backend (~3.3k lines in v1 `packages/opencode/src/session/claude-sdk-*.ts`) has no drop-in hook: it has to become a replacement for the location-scoped `SessionRunner` service. Section 3 has the details.

v1 paths are reachable via `git show dispatch-v1-final:<path>`. v2 paths are the working tree (which is now upstream/dev 2.1.2 + Dispatch docs).

Two facts that change the porting estimate:
- **The v1 tree was already Effect 4 and LayerNode-based** (`effect` 4.0.0-beta.83 vs upstream 4.0.1). v1 code used `Context.Service` and `LayerNode.make`. The real cost is that v1 used ALS/`InstanceState`/`AppRuntime` patterns and zod in `packages/opencode`, and v2 has none of those.
- **The npm scope changed** from `@opencode-ai/*` to `@opencode/*`. e.g. `@opencode-ai/core/v1/permission` has no v2 equivalent; permission concepts live in `@opencode/schema/permission` and `@opencode/core/permission`.

---

## 1. Package split

| Package (dir) | npm name | Responsibility |
|---|---|---|
| `packages/schema` | `@opencode/schema` | Effect `Schema` definitions only: Session, SessionMessage, SessionEvent, Permission, Form, Model, Provider, Location, Config, event manifest. No runtime services. |
| `packages/util` | `@opencode/util` | Effect infrastructure: `effect/layer-node.ts`, `effect/app-node.ts`, `effect/runtime.ts`, `observability*`, `global.ts`, `fs-util.ts`, `npm.ts`, `process.ts`. |
| `packages/ai` | `@opencode/ai` | Provider-neutral LLM client replacing the AI SDK on the main path: `LLMClient`, `LLMRequest`, `LLMEvent`, routes, protocols, transports, `providers/*`, `tool-runtime.ts`. Depends only on schema and http-recorder. |
| `packages/core` | `@opencode/core` (exports `./*` → `./src/*.ts`) | All domain services: session engine, tools, permissions, forms, bus, database, MCP, config, plugins, worktree, PTY. |
| `packages/protocol` | `@opencode/protocol` | `HttpApi` endpoint/group definitions (`src/groups/*.ts`), errors, `makeDefaultApi` (`src/api.ts`). |
| `packages/server` | `@opencode/server` | Implements protocol groups (`src/handlers/*`), location middlewares, SSE event feed, process entry (`src/process.ts`), route assembly (`src/routes.ts`). |
| `packages/client` | `@opencode/client` | Generated Effect and promise clients (`src/{effect,promise}/generated`), Solid stores (`src/solid/data.ts`, `connection.ts`, `pty.ts`) used by the TUI. |
| `packages/sdk` | `@opencode/sdk` | Composes client, core, server for embedding. |
| `packages/plugin` | `@opencode/plugin` | Plugin API types: `effect/*`, `promise/*` (default export), `tui/*`. |
| `packages/plugins/figma` | — | Example bundled plugin. |
| `packages/plugin-browser` | `@opencode/plugin-browser` | Browser tools plugin. |
| `packages/cli` | `@opencode/cli` | Binary entry `src/index.ts`, commands, server process, ACP, mini host. bin: `opencode`, `opencode2`. |
| `packages/tui` | `@opencode/tui` | OpenTUI/Solid UI. Client only; talks HTTP to a server. |

**Dependency direction** (root `AGENTS.md`): Schema → Core and Protocol → Server. Client may depend on Schema and Protocol, never Core or Server. SDK composes Client, Core, Server. `ai` cannot import `core`.

**Running it:**
- Dev: `bun run dev` at the root = `bun run --cwd packages/cli src/index.ts`.
- Live: `bun run dev:live [dir]` attaches the TUI to the background server.
- Build: `packages/cli/script/build.ts` (Bun compile on `./src/index.ts`) → `dist/<cli-target>/bin/opencode`. Flags: `--single`, `--target=`, `--outdir=`, `--skip-install`, `--skip-web-ui`.

**Tests and typecheck:**
- Tests refused from repo root. Per package: core uses `bun run script/test.ts` (sandboxed HOME/XDG); others `bun test`.
- Typecheck: `bun typecheck` inside a package (core runs `tsc -b tsconfig.json tsconfig.tests.json`). Full: `bun run check` at root. Never run `tsc` directly.

---

## 2. Effect layering: how Location replaces Instance

**v1** (`packages/opencode/src/effect/*`, `project/instance.ts`): `InstanceRef`/`WorkspaceRef`, `InstanceState.make/get/directory`, `Instance.bind(fn)` / `Instance.restore(ctx, fn)` (ALS), `AppRuntime.runPromise`.

**v2 primitives:**
- `@opencode/util/effect/layer-node.ts` (`LayerNode`): `make`, `unbound(service, tag)`, `group(nodes)`, `compile(root, { replacements, shared })`. `node.replace(nodeOrLayer)` returns a replacement. `Provider.mapLayer(f)` decorates an implementation keeping deps. In `compile`, replacements are a `Map<source, target>` lookup, so a replacement whose source isn't in a graph is silently ignored.
- `@opencode/util/effect/app-node.ts`: tags `global` and `location`, `makeGlobalNode`, `makeLocationNode`.
- `core/src/location.ts`: `Location.Service` (`directory`, `workspaceID`, `project {id, directory, canonical}`, `vcs`). `Location.node` is unbound and bound per instance via `Location.boundNode(ref)`.
- `core/src/instance.ts`: `Instance.graph` = group of all location-scoped nodes (Config, Agent, Provider, Model, ModelResolver, Plugin, Tool, Permission, Form, Mcp, Pty, SessionRunnerLLM, SessionCompaction, SessionTitle, SessionContext, Snapshot, Vcs, …). `Instance.layer(ref, { plugins, discovery, replacements })` compiles a fresh copy per `Location.Ref`, sharing global nodes.
- `core/src/instance/service.ts`: `Instance.Service.provide(session)` — global service that provides the session's location services to an effect.
- `core/src/location-service-map.ts` / `location-services.ts`: `LocationServiceMap.Service` is a `LayerMap<Location.Ref, Instance.Services>`; `get(ref)` returns a Layer; `canonical(ref)`; `reload()`; `buildLocationServiceMap(replacements)` builds every location with `Instance.layer(ref, { replacements: bindings })`.
- `core/src/location-lifecycle.ts`: `LocationLifecycle.Service` (`isClosed()`, `shutdown`).
- `core/src/effect/app-node-builder.ts`: `AppNodeBuilder.build(root, replacements)` wires `Instance.node` and `LocationServiceMap`.

**How a service gets the current directory:** `const location = yield* Location.Service` inside any location-scoped layer, then `location.directory`. No ambient reference. Global services (Session, SessionExecution, SessionStore, Bus, Database, Worktree, Project) take a ref or session explicitly and enter a location with `instances.provide(session)` or `Effect.provide(locations.get(ref))`.

**Server request resolution:**
- `packages/server/src/location.ts`: `LocationMiddleware` uses `requestRef(request)`: directory from `location[directory]` query param, else `x-opencode-directory` header, else `process.cwd()`. Provides `locations.get(ref)`. `response(data)` wraps as `{ location, data }`.
- `middleware/session-location.ts`: `SessionLocationMiddleware` reads `:sessionID`, loads the session, calls `instances.provide(session)` — session routes run at the session's own location. **(This replaces Dispatch's `withSessionInstance`.)**
- `middleware/form-location.ts`: same for forms; carries the `sessionID === "global"` MCP elicitation case.
- Protocol groups choose middleware; see `protocol/src/api.ts` `LocationGroups`.

**Plain async callbacks → runtime:** there is no ALS and no `Instance.restore`. Capture the context inside Effect and reuse it:
- `const runFork = Effect.runForkWith(yield* Effect.context())` (used in `mcp/client.ts`, `pty.ts`, `shell.ts`).
- `Effect.runPromiseWith(context)` (used in `mcp/oauth.ts`, `aisdk.ts`).
- `FiberSet.makeRuntime()` / `FiberSet.makeRuntimePromise()` for scoped forks (`run-coordinator.ts`, `mcp/index.ts`, `plugin/module.ts`).
The captured context includes `Location.Service` and every location service — the v2 equivalent of `Instance.bind`.

Other replacements:
- `State` (`core/src/state.ts`) replaces mutable `InstanceState`. Domains (Model, Provider, Agent, Tool, Mcp, Command, Compaction) are `State.Transformable<Editor>`: register a scoped synchronous `transform(editor => …)`; `reload()` rebuilds.
- `Rpc` (`core/src/rpc.ts`): location-scoped `register/call/client` plus `rpc.<id>.<event>` ephemeral bus events. Escape hatch for custom server-side APIs and events.

---

## 3. Session core v2

### Prompt lifecycle, end to end
1. **HTTP:** `POST /api/session/:sessionID/prompt` (`protocol/src/groups/session.ts`) → `server/src/handlers/session.ts` `"session.prompt"` → `Session.Service.prompt({ sessionID, id, text, files, agents, skills, metadata, delivery, resume })`.
2. **Admission:** `core/src/session.ts` `prompt` → `sessions.forSession(id).prompt` → `core/src/session/session.ts`. `SessionPrompt.prepare` (`session/prompt.ts`) runs inside `instances.provide(session)`: awaits plugin activation, runs the `session.prompt` plugin hook, materializes attachments, loads skills into a `SessionInbox.UserPayload`. The inbox `admit` publishes durable `session.inbox.enqueued`; its projection inserts a `session_inbox` row. IDs idempotent; `Session.PromptConflictError` on cross-type reuse.
3. **Wake:** unless `resume === false`, `SessionExecution.wake(sessionID)` (`session/execution.ts`), global process-local.
4. **Coordinate:** `SessionRunCoordinator.make` (`session/run-coordinator.ts`) coalesces wakes, joins same-session resumes, runs different sessions concurrently. `started` publishes `session.execution.started` with `store.claim`; `settled` publishes Succeeded/Failed/Interrupted and releases.
5. **Drain:** `execution.drain` calls `SessionRunner.Service.drain({ sessionID, force, continuation, promotable })` under `instances.provide(session)`. Loops on `DrainResult.Moved` and `Reloaded`.
6. **Runner** (`session/runner/llm.ts`, `SessionRunnerLLM.node`, location-scoped): `drain` runs `settleStaleCompactions`/`settleStaleToolCalls`, then loops `advanceToStep()` and `runStep()`. `advanceToStep` (inside `SessionInbox.serialized`) picks `SessionInbox.nextPromotable(db, id, "input"|"steer")`, handles compaction and move controls, runs `prepareContext` (`SessionContext.select` + `InstructionState.prepare`) and `SessionInbox.promote(db, bus, id, promotable)` (publishes `session.inbox.delivered`; projection deletes the row and inserts the user message). First promotion forks title generation; then `context.load(selected)`. `runStep`: auto compaction, `SessionModelRequest.baseTranscript`, `context.request.primary(...)` → `Prepared { request: LLMRequest, options, executeTool, retry }` (`session/model-request.ts`, runs plugin hooks `session.context` and `model.request`), then `SessionStep.attempt`.
7. **One step = one `llm.stream`** (`session/runner/step.ts`): forks a start snapshot, creates `createLLMEventPublisher(bus, { sessionID, assistantMessageID, agent, model, providerMetadataKey, pendingSnapshot, started })` (`runner/publish-llm-event.ts`), runs `llm.stream(request, options)` (`LLMClient.Service`); every `LLMEvent` goes through `publisher.publish`. For each `tool-call` where `!providerExecuted`, forks `prepared.executeTool` → `toolOutput.truncate` → `publisher.toolExecution`. After the stream: overflow-compaction, retry, `RecoverFull`, fail unsettled tools, end snapshot + diff files, `session.step.ended` with cost (`SessionUsage.calculateCost`) and tokens. Returns `Outcome.Completed({ needsContinuation })`. No in-memory tool loop.
8. **Persistence:** everything is durable `SessionEvent.*` on `Bus`. `SessionProjector` (`session/projector.ts`, global) folds events through `SessionMessageUpdater.update` (immer) into SQLite `session_message.data` and updates usage on `session`.
9. **Events out:** `Bus.listen` → `server/src/event-feed.ts` → SSE at `GET /api/event`. Clients use `@opencode/client/solid` `createData`.

Supporting: `store.ts` (`SessionStore`: get/list/messages/context/message/claim/release/listSuspended/countResume), `history.ts`, `message.ts`, `compaction.ts` (`SessionCompaction.Service.compact({ reason, context })`, location-scoped, State.Transformable), `title.ts`, `generate.ts`, `usage.ts`, `revert.ts`, `transfer.ts`, `move.ts`, `subagent-job.ts`, `subagent-completion.ts`.

### Mapping the fork's v1 claude-sdk call sites

| v1 call site | v2 counterpart |
|---|---|
| `session/prompt.ts` loop + `claude-sdk-processor.ts` | `core/src/session/runner/llm.ts` (`drain`/`runStep`) and `runner/step.ts` (`attempt`) |
| `session/compaction.ts` | `core/src/session/compaction.ts` |
| `session/summarize.ts` | `core/src/session/title.ts`, `session/generate.ts` |
| `server/.../handlers/session.ts` | `packages/server/src/handlers/session.ts` + `protocol/src/groups/session.ts` |
| `claude-sdk-permissions.ts` (`canUseTool`) | `core/src/permission.ts` `Permission.Service.assert/ask` (location-scoped) |
| `claude-sdk-session-map.ts` | own table (section 17) or `Session.metadata` |
| `claude-sdk-bridge.ts` (EventV2Bridge) | publish `SessionEvent.*` directly through the step publisher |

### Where to plug in the Claude Agent SDK `query()`

**Recommended: replace or decorate `SessionRunner.Service` for Anthropic models.**
- `SessionRunnerLLM.node.mapLayer(...)` or `.replace(...)`. Only `node` is exported from `runner/llm.ts`.
- The wrapper's `drain` resolves the session model (`SessionContext.select` then `context.load` → `loaded.model.ref.providerID`) and delegates to the stock runner for non-Anthropic.
- **Wiring:** pass replacements in `createRoutes(options, serviceURLs, overrides)` (`server/src/routes.ts`). Overrides flow through `AppNodeBuilder.build` → `buildLocationServiceMap(bindings)` → `Instance.layer(ref, { replacements })`. The `createRoutes(...)` call in `packages/server/src/process.ts` currently passes no overrides; `server/src/fetch.ts` passes `boot.overrides`. The CLI reaches it via `packages/cli/src/server-process.ts` → `import("@opencode/server/process")`. **Verify this path before building on it.**
- **The SDK drain must still own the inbox.** Reuse exported primitives: `SessionInbox.nextPromotable`, `SessionInbox.serialized`, `SessionInbox.promote(db, bus, sessionID, promotable)`; `InstructionState.prepare(db, bus, instructions, sessionID)`; `SessionContext.Service.select/load`; `SessionTitle.Service.generate`/`isUntitled`; `LocationLifecycle.isClosed()` → return `DrainResult.Reloaded`. `settleStaleToolCalls`/`settleStaleCompactions` are not exported — copy them.
- **Writing messages:** one `createLLMEventPublisher` per SDK assistant message (`@opencode/core/session/runner/publish-llm-event`; needs only `bus` and ids). **Hard constraint:** one publisher = one `assistantMessageID` = one step; a duplicate `step-finish` is a defect (`Effect.die("Duplicate step finish")`). Translate SDKMessages into `LLMEvent`s: `text-start/delta/end`, `reasoning-*`, `tool-input-start/end`, `tool-call { providerExecuted: true }`, `tool-result { providerExecuted: true, result }`, `step-finish { reason, usage }`. With all tools `providerExecuted`, `record().needsContinuation` is false and tool results become `session.tool.success` with `executed: true`. Then publish `SessionEvent.Step.Ended` with cost/tokens yourself, as `step.ts` does. Alternatively publish `SessionEvent.Step.Started`, `Text.*`, `Tool.Input.*`, `Tool.Called`, `Tool.Success/Failed`, `Step.Ended` directly.
- **This deliberately breaks the AGENTS.md rule** "one explicit `llm.stream` per step, no in-memory tool loop". The SDK owns the loop. Document the divergence.
- **Permissions:** `canUseTool` → `Permission.Service.assert(...)` (location-scoped; capture in the runner layer). Gotcha: `assert` turns a decline into a defect (`Effect.die(DeclinedError)`). Run via `Effect.exit` + `catchDefect` or a decline kills the drain fiber. `CorrectedError` (decline with feedback) stays typed.
- **Questions:** SDK `AskUserQuestion` → `Form.Service.ask` (section 7).
- **Interrupt:** `SessionExecution.interrupt` interrupts the drain fiber. Abort `query()` in an `onInterrupt` finalizer.

**Rejected alternative: custom `@opencode/ai` Route/Transport.** The model is built from JSON settings at `ModelResolver` time with no location services; `ai` cannot import `core`, so `canUseTool` can't reach `Permission`/`Form`; also one publisher per step vs many SDK turns per query.

---

## 4. Messages and parts
- **v2 schema:** `packages/schema/src/session-message.ts` (`SessionMessage`). `Info` union: `User | Synthetic | System | Skill | Shell | Assistant | Compaction | Idle | AgentSelected | ModelSelected | LocationSwitched`. IDs `msg_`. `Assistant`: `agent`, `model: Model.Ref`, `content: AssistantContent[]`, `snapshot { start, end, files }`, `finish`, `rawFinish`, `native`, `cost: Money.USD`, `tokens: TokenUsage.Info { input, output, reasoning, cache { read, write } }`, `error`, `retry`, `time { created, streamed, completed }`. Content: `AssistantText { text, native }`, `AssistantReasoning { text, time }`, `AssistantTool { id, name, executed?, native?, state, time { created, ran, completed } }`. `ToolState`: `streaming { input: string }` | `running { input, metadata }` | `completed { input, content, metadata? }` | `error { input, error: SessionError, content?, metadata? }`.
- **Events** (`packages/schema/src/session-event.ts`, re-exported `core/src/session/event.ts`): `session.step.started/streamed/ended/failed`; `session.text.started/delta(ephemeral)/ended`; reasoning same; `session.tool.input.started/delta/ended`, `session.tool.called`, `progress`, `success`, `failed`; `session.usage.*`, `session.inbox.*`, `session.execution.*`, `session.compaction.*`, `session.revert.*`, `session.synthetic`, `session.moved`.
- **Storage:** `core/src/session/sql.ts`: `SessionTable`, `SessionMessageTable` (`session_message`: `id, session_id, type, seq, data` JSON), `SessionInboxTable`, legacy `SessionPendingTable`, instruction tables.
- **Updates:** projector + `SessionMessageUpdater.update(adapter, durableEvent)` rewrite the whole assistant row per event. Deltas are live-only; `*.ended` events carry the full value.

## 5. Tools and subagents
- `core/src/tool.ts` `Tool.Service`, location-scoped, `State.Transformable<Editor>` (`add/update/remove/namespace`). `snapshot(permissions)` → `{ definitions, execute }`. Rules in `core/src/tool/AGENTS.md`: namespaces flatten to `<ns>_<tool>`, `codemode` defaults true. Built-ins as plugins under `core/src/tool/plugin/*`: shell, read, write, edit, patch, glob, grep, webfetch, websearch, todo, question, skill, subagent, mcp-resource, opencode. MCP tools via `tool/mcp.ts`.
- Plugin tools: `ctx.tool.transform(editor => editor.add({ name, description, input, output, execute(input, ctx) }))` (`plugin/src/effect/tool.ts`).
- **Subagents** (`tool/plugin/subagent.ts`): tool name `subagent`. Input: `prompt`, `description`, `agent`, optional `sessionID`, optional `background`. Runs `Session.create({ parentID })`, `Session.prompt(...)`, `SubagentJob.start`. Foreground: `jobs.block({ id })`; output `SubagentCompletion.text(lastAssistant)`. Background: `SubagentCompletion.deliver` injects `session.synthetic` into the parent. `SubagentJob` global, built on `Job` (`core/src/job.ts`).

## 6. Permissions
- `core/src/permission.ts`: `evaluate(action, resource, ...rulesets)` uses `findLast` with `Wildcard.match`; default ask. Rules `{ action, resource, effect: allow|deny|ask }`. `Permission.Service` is **location-scoped**; pending requests live in an in-memory `Map` per location instance, rejected on location close. API: `ask(input)` → `{ id, effect }` non-blocking; `assert(input)` blocks on a Deferred; `reply({ requestID, reply: once|always|reject, message? })`; `get`; `forSession`; `list`; `close`. Rules from agent permissions + `session.permissions` + saved rules; `permission.evaluate` plugin hook can override. `always` saves `request.save` patterns. Events `permission.asked`, `permission.replied`.
- Saved approvals: `permission/saved.ts` (global, per `projectID`, `permission/sql.ts`). Managed policy: `core/src/managed-policy.ts`.
- HTTP: `protocol/src/groups/permission.ts`, `server/src/handlers/permission.ts`.

## 7. Questions and forms
- `core/src/form.ts` `Form.Service` (location-scoped): `create`, `ask` (blocks), `get`, `list`, `state`, `reply({ id, answer })`, `cancel`, `close`. Fields `string | number | integer | boolean | multiselect | external` (`schema/src/form.ts`). Events `form.created`, `form.replied`, `form.cancelled`.
- `tool/plugin/question.ts`: asserts permission `question`, then `forms.ask({ sessionID, title: "Questions", metadata: { kind: "question", tool: { messageID, id } }, fields: q0..qN })`. Answers at `state.answer["q<i>"]`. Cancel without message → defect `QuestionTool.CancelledError`; with message → `ToolFailure`.
- HTTP: `/api/session/:sessionID/form...`, `protocol/src/groups/form.ts`, `server/src/handlers/form.ts` (`FormLocationMiddleware`). TUI: `packages/tui/src/routes/session/form.tsx`. MCP elicitation also produces forms.

## 8. Events
- `core/src/bus.ts` `Bus.Service` (global): `publish(def, data, { id, metadata, location, global, commit })`, `publishAll`, `subscribe()` (volatile, filtered by ambient location if any), `log({ aggregateID, after, follow })`, `listen` (deprecated), `project`, `replay`, `claim`. `Event.durable({ type, durable: { aggregate, version }, schema })` vs `Event.ephemeral(...)` (`schema/src/event.ts`).
- Server feed: `server/src/event-feed.ts` `EventFeed.layer = make(bus.listen)`, served by `handlers/event.ts` at `GET /api/event` (SSE). Sends `server.connected` first, heartbeat 15s. **Not location-filtered** ("across all server locations"); events carry `location?`. Only events passing `isOpenCodeEvent` are emitted: types in `EventManifest.ServerDefinitions` (`schema/src/event-manifest.ts`) or any `rpc.*` type. **Custom fork events must be registered in `event-manifest.ts` or go through `Rpc.register(def).events.emit(...)`.** Slow consumer overflow (4096) fails the stream.
- TUI: `tui/src/context/client.tsx` → `createClientConnection(api, { onEvent })`; `context/event.ts` `useEvent().on/subscribe` passes `{ directory: event.location?.directory }` — filtering is client-side. State from `@opencode/client/solid` `createData` wrapped by `context/data.tsx`.

## 9. Server, protocol and client
- Endpoints in `packages/protocol/src/groups/*.ts`: `HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", { params, query, payload, success, error })`. Groups via `make*Group(middleware)`. `makeDefaultApi({ locationMiddleware, formLocationMiddleware, sessionLocationMiddleware })` (`protocol/src/api.ts`) instantiated in `server/src/api.ts`.
- Handlers: `HttpApiBuilder.group(Api, "server.session", handlers => handlers.handle("session.prompt", Effect.fn(function*(ctx){ ... })))`, listed in `server/src/handlers.ts`.
- Middleware: `middleware/authorization.ts`, `schema-error.ts`, `session-location.ts`, `form-location.ts`. Options `server/src/options.ts` (`ServerOptions`).
- Assembly: `server/src/routes.ts` `createRoutes`/`createEmbeddedRoutes`; `applicationServiceNodes`; standard replacements; `AppNodeBuilder.build`.
- Codegen: after changing protocol or server `HttpApi`, run `bun run generate` in `packages/client` (writes `src/{effect,promise}/generated`). Never hand-edit. `packages/protocol` also has `generate` for OpenAPI.

## 10. Providers and models
- `packages/ai/src/providers/<id>.ts` (e.g. `anthropic.ts`): `id`, `routes`, `configure({ apiKey|auth, baseURL, providerOptions })` → `.model(id)`, exported `model(modelID, settings)` = `ProviderPackage.Definition` (`ai/src/provider-package.ts`).
- `core/src/provider.ts` `Provider.Service` (location, State); `builtins` map lists `@opencode/ai/providers/*`; `aisdk:` prefix = legacy AI SDK packages via `aisdk.ts`. `core/src/model.ts` `Model.Service` (`list/get/update/remove/default/provider`). `core/src/model-resolver.ts` imports `model.package ?? provider.package` → `definition.model(modelID, settings)` → `LanguageModel`. `core/src/models-dev.ts` + `models-dev/snapshot.txt` catalog; `plugin/models-dev.ts`. Provider auth plugins in `core/src/plugin/provider/*.ts`.
- **Adding static models / custom provider:** plugin with `ctx.provider.transform(e => e.add({ info: { id, name, package, … }, models: [Model.Info …] }))` or `ctx.model.transform(e => e.update(...))`. `Model.Info`: `id, modelID, providerID, package?, capabilities, variants, cost[], limit { context, output }, status, enabled`. A provider routing to the SDK backend should still resolve to a valid `LanguageModel` since history/compaction/title may use it; the SDK runner switches on `providerID`/metadata before any `llm.stream`.

## 11. Config, agents and commands
- `core/src/config.ts` `Config.Service`: `entries()` (layered: system, global, project, `.opencode`, `.claude`, `.agents`, `opencode.json[c]`, `config/discovery.ts`), `changes()`. Schema `packages/schema/src/config.ts` + `config/*`. Each domain has a config plugin in `core/src/config/plugin/*.ts`. `core/src/v1/config/*` migrates legacy.
- Agents: `core/src/agent.ts` `Agent.Service`. `Agent.Info` `{ id, name, model?, request, system?, description?, mode: primary|subagent|all, hidden, color?, steps?, permissions }`. Built-ins/prompts in `core/src/plugin/agent.ts`: build (default), general, explore, compaction, plus title/summary prompts. Plan is `core/src/plugin/plan.ts`.
- Commands: `core/src/command.ts` `Command.Service` (`Definition { name, execute(invocation) }`); built-ins `plugin/command.ts` + `plugin/command/*.txt`.
- Keybinds: `packages/tui/src/config/keybind.ts` `TuiKeybind`; `config/v1/keybind.ts` legacy.

## 12. MCP
- `core/src/mcp/index.ts` `Mcp.Service`, **location-scoped** (`configured()` is a `makeLocationNode`), one connection set per location. API: `servers, add, connect, disconnect, remove, tools, callTool, prompts, resources, readResource, instructions`. Status: `pending, connected, failed, needs_auth, disabled`.
- Failures: `client.onclose` sets `failed`, stops the server, publishes `McpEvent.StatusChanged`. **No auto-reconnect** after close; only `MCP.SessionExpiredError` triggers `recover` (stop, restart, retry once). `client.onerror` (`mcp/client.ts`) only records `lastError` and logs.
- `onToolsChanged` → `refreshTools` → `mcp.tools.changed`. `mcp/stdio.ts`, `mcp/oauth.ts`, `mcp/instructions.ts`.

## 13. Worktrees and workspaces
- `core/src/worktree.ts` `Worktree.Service` (global): `list, create, remove, refresh`, `WorktreeTable` (`worktree/sql.ts`). `create`: strategy settings from project location (`WorktreeStrategies`); parent dir = `input.directory`, else `<Global.data>/worktree/<projectID[0..6]>`, config-overridable (`config/plugin/worktree.ts`, `~/` or project-relative); name `input.name ?? Slug.create()` with `-2…-10` suffix on collision; git strategy runs `git worktree add --detach -- <dir> <branch ?? HEAD>` — **no branch is created**; project `commands.start` runs with `OPENCODE_WORKTREE_BASE`/`OPENCODE_WORKTREE_PATH`.
- `worktree/directory.ts` `WorktreeDirectory.canonical`. `workspace.ts` `Workspace.Service` remote/provisioned placement; `Location.workspaceID` reserved. Server: `handlers/worktree.ts`, `handlers/vcs.ts` (`core/src/vcs.ts`, location-scoped).

## 14. PTY and terminals
- `core/src/pty.ts` `Pty.Service` (location) at `/api/pty`, WebSocket connect token (`pty/ticket.ts`). `core/src/persistent-pty/*` `PersistentPty` (global) daemon surviving restart. Endpoints `/api/experimental/session/:id/terminal`, `/api/experimental/persistent-pty/...`. Server handlers `pty.ts`, `pty-socket.ts`, `persistent-pty.ts`. TUI: `routes/session/composer/terminals-tab.tsx`, `context/session-terminals.tsx` (`client.api.experimental.persistentPty.list/create`, `client.persistentPty`).

## 15. TUI
- **Process model:** the TUI is **never in-process with core.** `packages/cli/src/commands/handlers/default.ts` → `ServerConnection.resolve(...)`: managed background service or `--standalone` (spawns `opencode serve --stdio --port 0`, `services/standalone.ts`), then `run(...)` from `@opencode/tui` with `server.endpoint`. `server-process.ts` runs the server (`default`, `service`, `stdio`), lazily importing `@opencode/server/process`. `mini-host.ts` + `commands/handlers/mini.ts` host `tui/src/mini/*`.
- **Structure** (`packages/tui/src`): `index.tsx` (`run`), `app.tsx`, `runtime.tsx`; `context/*` (client, data, event, location, keymap, route, session-tabs, permission, prompt, …); `routes/home.tsx`; `routes/session/*` (`index.tsx`, `message-parts.tsx`, `permission.tsx`, `form.tsx`, `sidebar.tsx`, `composer/*`); `component/*`; `feature-plugins/*` (sidebar, home, prompt, system/diff-viewer, stats); `plugin/*` TUI plugin loader.
- **Multiple locations:** data is location-keyed (`locationKey`, `data.location.sync(ref)`); session list spans locations (`Session.ListFilter`: directory, project, all). Session tabs and subagents tab from `parentID` trees.

## 16. Logging
- Effect only: `Effect.logInfo/logWarning/logError`, `Effect.annotateLogs`. `@opencode/util/observability.ts` `Observability.layer()` installs a file logger at `Global.Path.log/opencode[-<channel>].log` (50 MB trim), stderr when `OPENCODE_PRINT_LOGS=1`, OTLP. Level `OPENCODE_LOG_LEVEL`. No `Log.create` equivalent; from plain async code, capture `Effect.runForkWith(yield* Effect.context())` and run `Effect.log*`.

## 17. Database
- `core/src/database/database.ts` `Database.Service` (global, Effect-drizzle SQLite). Default `:memory:`; CLI passes `databasePath(Global.data)` (`cli/src/database-path.ts`): `OPENCODE_DB`, else `~/.local/share/opencode/opencode.db` (latest/dev/beta/next/prod) else `opencode-<channel>.db`.
- Migrations: `src/database/migration/*.ts`, `migration.gen.ts`, `schema.gen.ts`/`schema.json`. Adding a table: define `sqliteTable` in `*.sql.ts`/`sql.ts` (snake_case; drizzle globs `./src/**/sql.ts`); `bun run migration --name <x>` in `packages/core` (`--check` verifies); commit the generated files. `v1-migration.*` imports v1 JSON storage.

## 18. Plugins
- Server plugins: `@opencode/plugin/effect` `define({ id, effect: (ctx) => Effect<void, never, Scope> })`. `Context` domains: `agent, aisdk, command, event, integration, mcp, model, provider, permission, rpc, session` (hooks `prompt, context, compaction, generate, title, model.request, http.request/response, experimental.ws.*, retry`), `shell, skill, storage, tool, vcs, websearch, worktree, generate, credential`. Promise API is the default `@opencode/plugin` export. Core host: `core/src/plugin.ts`, `plugin/host.ts`, `plugin/supervisor.ts`, `plugin/instance.ts`; per location (`InstancePlugins`); `Plugin.awaitActivation` gates sessions. Built-in internal plugins in `core/src/plugin/internal.ts`. Tools via `ctx.tool.transform(editor => editor.add(...))`.
- TUI plugins: `@opencode/plugin/tui` `define({ id, setup(ctx) })`; `ctx` includes `data` (sessions, messages, permissions, forms, locations), slots, pages, panels.
- `packages/plugin-browser` browser automation plugin with tools and RPC.
