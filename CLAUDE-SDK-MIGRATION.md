# Claude Agent SDK runner (v2)

Dispatch runs every Session whose model is on the `anthropic` provider through
`@anthropic-ai/claude-agent-sdk` `query()` instead of opencode's own `llm.stream` loop. Auth comes from
the Claude Code login already on the machine (subscription or API key), so no Anthropic API key is
needed. Every other provider runs on the stock v2 runner unchanged.

This doc explains how that is built on opencode v2. The short reference for the same code is
`packages/dispatch/AGENTS.md`; the merge-time view is `UPSTREAM-SYNC.md`.

## The rule this breaks

The root `AGENTS.md` says each step is one explicit `llm.stream` call and there is no in-memory tool
loop. The SDK path breaks that on purpose: the SDK owns the tool loop and its built-in tools (Bash,
Read, Write, Edit, Glob, Grep, Agent/Task, ...). One drain turn is one `query()`, resumed from the stored
SDK conversation, and it may make many API calls before it returns a result. Everything else in the
v2 session model still holds: the runner owns the inbox, every fact is a durable `SessionEvent`, and
each API call becomes exactly one v2 step.

## Where it plugs in

v2 has no hook inside the stock runner, so Dispatch replaces the Location's `SessionRunner`:

- `packages/server/src/process.ts` passes `DispatchOverrides.replacements`
  (`packages/dispatch/src/overrides.ts`) to `createRoutes(...)`. The replacements reach
  `Instance.layer(ref, { replacements })` for every Location. All server entries (`serve`,
  `serve --stdio`, the managed service) go through `ServerProcess.start`, so this is the only wiring.
- `packages/dispatch/src/location.ts` replaces `SessionRunnerLLM.node` with a node that re-exposes the
  Dispatch runner and carries Dispatch's other location services as `deps` (the `dispatch` RPC). A
  replacement can only swap an existing node, so this is how extra location code gets built into every
  Location.
- `packages/dispatch/src/runner/node.ts` is the runner. It depends on
  `SessionRunnerLLM.node.mapLayer((layer) => layer)`: a copy of the stock runner with a new identity.
  The replacement map keys on node identity, so depending on the original node would resolve back to
  the Dispatch node.

`drain` loads the Session, resolves its model with `SessionContext.resolveModel`, and checks
`SdkModels.isSdkModel` (provider id is `anthropic`). If not, it calls the stock runner. Note that this
covers every Anthropic model, not only the six static aliases, because the models plugin points all
Anthropic models at the SDK package (see "Models").

## The Effect boundary

`canUseTool`, hooks and MCP request handlers are called by the SDK on the CLI's control channel, as
plain async code with no Effect fiber. v2 has no AsyncLocalStorage and no `Instance.restore`, and none
is needed:

- The runner layer captures its context once: `Effect.context<SdkPermission.Requirements | Mcp.Service | Session.Service>()`.
- Every callback runs its Effect through `Effect.runPromiseWith(services)`, optionally with the
  callback's abort signal. The captured context already contains `Location.Service` and every
  location service, so callbacks land in the right Location with no ambient state.
- Any service a callback uses must be listed in the runner node's `deps`. If it is not, the captured
  context will not contain it and the callback fails at runtime. `packages/dispatch/test/boundary.test.ts`
  guards this by invoking a callback outside any fiber and checking it reaches `Permission.Service` for
  the right Location.
- Logging from callbacks is plain `Effect.log*` through the same context.

The claude.ai bridge (`packages/dispatch/src/bridge/service.ts`) is a global node and captures its own
context the same way.

## Inbox ownership

The SDK drain owns the inbox exactly like `packages/core/src/session/runner/llm.ts`:

1. If nothing is promotable and the drain is not forced, return `DrainResult.Complete()`.
2. `plugins.awaitActivation`, then settle stale state left by a dead process: running compactions fail
   as interrupted, streaming/running tools fail as aborted. Both helpers are copies of unexported code
   in the stock runner; keep them in sync when upstream changes it.
3. Loop: if `LocationLifecycle.isClosed()`, return `DrainResult.Reloaded`. Inside
   `SessionInbox.serialized`, take `SessionInbox.nextPromotable`. A `move` control publishes
   `InboxDelivered` + `Moved` and returns `DrainResult.Moved`. A `compaction` control runs SDK compaction.
   Otherwise `context.select`, `InstructionState.prepare`, then `SessionInbox.promote`.
4. On the first promotion of an untitled top-level Session, fork title generation (`SessionTitle.generate`).
5. Run one SDK turn on `context.load(selected)`.

A steer that arrives while a `query()` is running stays in the inbox. It is promoted when the query
ends and answered by the next `query()`.

## One turn

`SdkQuery.pending` (`packages/dispatch/src/runner/query.ts`) collects every message after the last
assistant or compaction message that the model should see: user prompts, synthetic notes, invoked
skills, instruction updates (wrapped in `<system-reminder>`), and finished foreground `!cmd` shell runs
(same wording as `core/src/session/runner/to-llm-message.ts`). `SdkQuery.prompt` joins them into one
user turn. Images and PDFs become Messages API `image`/`document` blocks; text attachments are inlined
as `<file>`; other files are named.

`SdkQuery.options` builds the `query()` options:

- `model`: `SdkModels.cliModel(...)` maps an alias to the id the CLI accepts (e.g. `opus-5-5` →
  `claude-opus-5-5[1m]`).
- `systemPrompt`: the agent's system prompt plus rendered instructions. `core/date`,
  `core/environment` and `core/codemode` are skipped; the CLI has its own environment block.
- `cwd`: the stored resume `cwd`, else the Location directory.
- `env` (`packages/dispatch/src/sdk/env.ts`): the process env minus variables that make the CLI think it
  is nested in another Claude Code session, plus `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` (keeps
  native 1M windows behind a local `ANTHROPIC_BASE_URL` proxy), `ENABLE_TOOL_SEARCH=false` (the
  optimistic tool search returns empty results that models read as dead MCP servers), and
  `ANTHROPIC_API_KEY` when one is found (env first, then a stored Anthropic key credential; OAuth
  credentials fall through to the Claude Code login).
- `permissionMode: "default"`, so `canUseTool` stays in charge (`bypassPermissions` would shadow it).
- `strictMcpConfig: true`, so the CLI never loads `.mcp.json`, `~/.claude.json` or claude.ai connectors.
- `effort` from the model variant (`low/medium/high/xhigh/max`).
- `settings.autoCompactWindow` = context window clamped to 100k..1M (the CLI drops anything else),
  and `settings.advisorModel` from the config `advisor` key, read every turn so a change applies live.
- `hooks.PreToolUse` (subagent hook) and `hooks.PostCompact` (captures the compaction summary).
- `includePartialMessages: true`, so text and tool input stream.
- `pathToClaudeCodeExecutable` from the embedded binary, when there is one.

The stream is read with `Stream.fromAsyncIterable` and every frame goes to the router. Interrupting the
drain fiber aborts the CLI (`abortController.abort()`) and settles every open message as interrupted.

## Message, step and token mapping

`packages/dispatch/src/runner/router.ts` routes frames; `runner/writer.ts` writes one Session's view.

- Each top-level API call (one SDK `message.id`) is one v2 assistant message with its own
  `createLLMEventPublisher` (`core/src/session/runner/publish-llm-event.ts`). A publisher allows exactly
  one `step-finish`; a second is a defect. Closing a message publishes one `step-finish` and one
  `SessionEvent.Step.Ended` with tokens and cost (`SessionUsage.calculateCost` with the catalog price).
- Tokens on a message are that call's usage, merged frame by frame and **replaced, never summed**.
  Input counts non-cached + cache read + cache write. So the TUI context gauge reads the latest call.
  The SDK result's cumulative totals are not written anywhere.
- Text, reasoning and tool input stream from `stream_event` frames; complete `assistant` frames fill in
  anything not already streamed. A reasoning block opens on its first text, because models that omit
  thinking stream empty blocks.
- Every tool is provider-executed. Results come from the SDK's `tool_result` blocks in `user` frames and
  are published on the message that published the call. A tool still open when its message closes fails
  with `tool.result-missing`.
- Tool part names and inputs use the v2 vocabulary (`packages/dispatch/src/sdk/adapter.ts`): `Bash` →
  `shell`, `Read` → `read`, `Write` → `write`, `Edit`/`MultiEdit`/`NotebookEdit` → `edit`, `Agent`/`Task`
  → `subagent`, `AskUserQuestion` → `question`, `mcp__<server>__<tool>` → `<server>_<tool>`; snake_case
  inputs become the camelCase shapes the TUI renders.
- Advisor: a `server_tool_use` block named `advisor` opens an `advisor` tool part; the matching
  `advisor_tool_result` completes or fails it.
- Errors: an SDK error result fails the open message with `provider.unknown`. A decline without
  feedback ends the turn as interrupted, like the stock runner, and the CLI's trailing error is not
  shown as a second failure.

## Compaction

- **Auto:** the CLI compacts on its own at `autoCompactWindow`. The `compact_boundary` frame (trigger
  `auto`) closes the open message, publishes `Compaction.Started`, waits up to 3s for the `PostCompact`
  hook's summary, then publishes `Compaction.Ended` with that text.
- **Manual:** a `compaction` inbox control runs `compact` in `runner/node.ts`: a `/compact` query with
  `maxTurns: 1` on the resumed SDK session, waiting for `compact_boundary`. With no SDK conversation yet,
  or no boundary, it publishes `Compaction.Failed` (and drops the resume entry on failure).

## Permissions and forms

`packages/dispatch/src/runner/permission.ts`:

- `canUseTool` asks v2's `Permission.Service.assert` for every main-thread call. It first waits (up to
  5s) for the router to publish the tool part, since the SDK can ask before the stream reader has seen
  the call; that lets the request link to its tool part.
- File tools go through `FileAccess` (external-directory gate), then ask action `read` (Read) or `edit`
  (Write, Edit, MultiEdit, NotebookEdit). Note the permission action for Write is `edit` while its tool
  part is named `write`. The edit diff is computed before approval and stashed so both the prompt and
  the finished tool part show it. Bash is parsed with `ShellParse` and asks `shell` per command.
  Everything else is mapped by `SdkAdapter.permission`.
- `assert` turns a plain decline into a defect (`DeclinedError`). The bridge runs it under `Effect.exit`
  and answers the SDK `{ behavior: "deny", interrupt: true }`, which ends the turn as interrupted.
  `CorrectedError` (decline with feedback) is sent to the model as "User rejected permission with the
  following feedback: …". `BlockedError` passes its message through.
- `AskUserQuestion` asks permission `question`, then `Form.Service.ask` with `metadata.kind: "question"`
  and one field per question (`q0`, `q1`, …), which the TUI's question UI renders. The answers go back
  as `updatedInput.answers`. A dismissed form without a message interrupts the turn.
- Permission replies arrive through `POST /api/session/:sessionID/permission/:requestID/reply`, which
  runs at the Session's Location, so the dashboard can answer a worktree agent's prompt.

## Subagents

- The PreToolUse hook forces `run_in_background: false` on `Agent`/`Task`. A backgrounded subagent
  outlives the `query()` that started it and is killed with it, and the model then reports it as a
  permission problem.
- Subagent tool calls (`agent_id` on the hook event) never reach `canUseTool` unless the hook answers
  `ask`. The hook evaluates the parent's rules (agent rules, then Session rules, then saved approvals):
  any deny wins, all allow allows, anything else asks.
- Frames with `parent_tool_use_id` go to a child Session, created with `parentID`, title
  `"<description> (@<agent> subagent)"`, the subagent prompt as its first user message, and
  `metadata: {}` (children inherit metadata by default, including the parent's SDK resume entry). The
  parent's `subagent` tool part carries `metadata.sessionID`, so the subagents tab and navigation work.
  `task_progress` updates that part; a failed `task_notification` fails it.

## MCP proxy and plugin tools

`packages/dispatch/src/runner/mcp.ts`:

- The Location's connected MCP servers are proxied into each query as in-process SDK MCP servers. Each
  query gets fresh proxy objects, because MCP is point-to-point and a shared proxy disconnects the first
  session.
- Tool definitions come from the last good listing, so a reconnecting server keeps its tools. Servers
  with status `disabled` are left out. Before building the set, the runner waits up to 10s for servers
  still `pending` after Location boot, since a query's servers are fixed when it starts.
- Each call checks the server status first and fails with "MCP server X is not connected" when it is
  down. Raw request handlers keep the servers' original JSON schemas.
- Tools from non-builtin opencode plugins are exposed as one more in-process server, `opencode-plugins`,
  executed through v2's tool runtime.
- Reconnect with backoff and the health check live in core (`packages/core/src/mcp/index.ts`), not here.

## Session resume

`packages/dispatch/src/sdk/session-map.ts` stores `{ sessionID, uuid, cwd }` in
`Session.metadata["dispatch.sdk"]` when the CLI's `system:init` frame reports its session id. Forks and
children inherit metadata, so an entry is honoured only by the Session it names. Resume always uses the
stored `cwd`, because the SDK keeps transcripts per project directory. If the CLI fails with "No
conversation found" before any output, the entry is dropped and the turn retries once without resume.

## Models and single-shot calls

- `packages/dispatch/src/plugin/models.ts` enables the `anthropic` provider with no credential, adds the
  static models from `packages/dispatch/src/sdk/models.ts` (`default` hidden, `fable-5-1`, `opus-5-5`
  default, `opus-4-6[1m]`, `sonnet`, `haiku`) with catalog prices, and sets package
  `aisdk:@opencode/dispatch/claude-agent-sdk` on every Anthropic model. Every 1M Opus alias keeps the
  `[1m]` suffix; a bare id makes the CLI report a 200k window. Sonnet 5 is native 1M and rejects the suffix.
- Title generation, `generate` and summary compaction on the stock path call `llm.stream` with a resolved
  model. The plugin's `aisdk` `sdk` hook answers the Dispatch package with
  `packages/dispatch/src/sdk/language-model.ts`: a one-turn, tool-free `query()` with no settings
  sources, no persisted session and tools denied. So those callers work on a subscription.
  `packages/core/src/plugin/provider/dynamic.ts` skips `@opencode/dispatch/*` so core never tries to
  npm-install the package.
- `session.lastResponse` (the dashboard's agent summary) uses its own one-turn Haiku `query()` for
  Anthropic sessions (`packages/dispatch/src/rpc/last-response.ts`).

## Embedded CLI binary

`packages/cli/script/build.ts` installs every platform's `@anthropic-ai/claude-agent-sdk-<os>-<arch>`
package and, per target, a Bun plugin serves `./bin.gen.ts` (imported from `packages/dispatch/src/sdk/`)
as a file import of that target's `claude` binary. `packages/dispatch/src/sdk/bin.ts`
`resolveClaudeBin()` imports it and extracts the binary out of `$bunfs` with `extractFromBunfs`, since the
SDK cannot spawn from there. In dev the module does not exist, the import fails, and the SDK finds its own
binary in `node_modules`.

## claude.ai mirroring bridge

`packages/dispatch/src/bridge/service.ts` (`DispatchBridge`, a global node) attaches Sessions to
claude.ai/code through the SDK's alpha `@anthropic-ai/claude-agent-sdk/bridge`, using the Claude Code OAuth token
(the macOS login Keychain, or `~/.claude/.credentials.json` on Linux and Windows). It works behind a local `ANTHROPIC_BASE_URL` proxy.

- Attaching is explicit: RPC `dispatch-bridge` (`session.remoteControl`, `remoteControlStop`,
  `remoteControlList`, in `packages/dispatch/src/bridge/rpc.ts`). It is a separate id from `dispatch`
  because one RPC id resolves to its last registration only.
- The mapping `{ codeSessionID, mark }` lives in `Session.metadata["dispatch.bridge"]`; live handles are
  module maps in `bridge/mirror.ts`. Deleting the Session closes its attachment.
- The runner tees every SDK frame to the mirror while one is attached (`bridge.turn(sessionID)` in
  `runner/node.ts`) and ends the remote turn on every path. Permission prompts and questions are offered
  to claude.ai too; both surfaces call the same `reply`, so whichever answers first wins.
- Text typed on claude.ai answers a pending question, or becomes a prompt run as the `yolo` agent so a
  phone prompt never blocks on an approval. A remote interrupt calls `SessionExecution.interrupt`.
- Mirroring is best effort: no bridge failure may fail a local turn. Hook points are marked
  `// Dispatch bridge:`.

## What changed from v1

v1 lived in `packages/opencode/src/session/claude-sdk-*.ts` and branched inside `SessionPrompt.loop()`
(`model.providerID === "anthropic"`). It wrote v1 `MessageV2` parts directly, set tokens once from the
SDK result totals, and reached services from SDK callbacks through AsyncLocalStorage (`Instance.restore`
plus an ALS-first `attach()`), which caused two silent outages. The SDK session map and bridge mapping were
JSON side files, MCP state was made global, and a module-level permission/question pending map let the
TUI answer worktree agents.

In v2 the runner is a replacement location node, callbacks use a captured Effect context, writes go
through `createLLMEventPublisher` one message per API call with per-call tokens, state lives in
`Session.metadata`, and session-location middleware makes the global pending maps unnecessary. The old
code is readable with `git show dispatch-v1-final:packages/opencode/src/session/claude-sdk-query.ts`
(and the other `claude-sdk-*` files).
