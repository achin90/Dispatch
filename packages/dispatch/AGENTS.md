# @opencode/dispatch

Dispatch's fork code. It plugs into v2 through extension points; upstream files are only touched at
registration points, each marked `// Dispatch:`.

## Wiring

- `src/overrides.ts` is the list of layer replacements `packages/server/src/process.ts` passes to
  `createRoutes(...)`. Every server entry (`serve`, `serve --stdio` behind `--standalone`, the
  managed service) goes through `ServerProcess.start`, so these apply to every Location.
- `src/location.ts` replaces `SessionRunnerLLM.node` with a node that re-exposes the Dispatch runner
  (`src/runner/node.ts`) and carries Dispatch's other location services as deps (today the `dispatch`
  RPC, `src/rpc/node.ts`). A replacement can only swap an existing node, so this is how extra
  location-scoped code gets compiled into every Location.
- `src/runner/node.ts` depends on a fresh copy of the stock node
  (`SessionRunnerLLM.node.mapLayer((layer) => layer)`): the replacement map keys on node identity, so
  depending on the original would resolve back to the replacement.
- `src/plugin/register.ts` replaces the host `SdkPlugins` store with one seeded with Dispatch's
  server plugins (`define()` from `@opencode/plugin/effect/plugin`). Add new Dispatch plugins to its
  `plugins` list. They activate after the internal `pre` plugins and before `post` (config) plugins.
  These plugins get only the plugin `Context` (`ctx.*`), never core services: anything that needs
  `Mcp.Service`, `SessionStore` and so on belongs in a location node like `src/rpc/node.ts`.

## Server plugins

- `plugin/agents.ts`: `build` (asks on `shell`/`edit`), `yolo` and `assistant` (`assistant.txt`
  prompt), all primary; removes `plan`. The switcher order build → yolo → assistant → config agents
  falls out of the agent map's insertion order, since these run after `opencode.agent`/`opencode.plan`.
- `plugin/commands.ts`: `/deepReview` and `/merge`; `$ARGUMENTS` is replaced, else arguments append.
- `plugin/worktree.ts`: the `dispatch` worktree strategy, selected as default by registering last.
  A worktree is `<parent of source repo>/<repo>-<slug>` on a new branch `<slug>` (`git worktree add
  -b`), with `-2`, `-3`… when the directory or branch is taken. Core picks the slug (requested name
  or random) and passes it as the basename of `directory`; `branch` is only the start ref. `remove`
  also deletes the branch (v1 behaviour) and reports `forceRequired` for dirty trees. Worktrees made
  by the stock `git` strategy keep being removed by it (core dispatches on the stored strategy id).

## The `dispatch` RPC

Defined in `src/rpc/definition.ts` (Standard Schema, imports only `effect` and `@opencode/schema`, so
the TUI may import it). Methods mirror the v1 `/experimental/*` dashboard routes:
`gitRepos.list`, `github.status|pr|createPr|mergePr`, `worktree.info|diff|diffstat`,
`session.lastResponse`, `mcp.health`. `directory`/`cwd` inputs default to the request's Location.

Calling it from the TUI (promise client, `client.api`):

```ts
import { DispatchRpc } from "@opencode/dispatch/rpc/definition"
const dispatch = client.api.rpc(DispatchRpc.Definition)
const stat = await dispatch["worktree.diffstat"](undefined, { location: { directory } })
// untyped: client.api.rpc.call({ rpcID: "dispatch", method: "worktree.diffstat", input: {}, location: { directory } })
```

Over HTTP: `POST /api/rpc/dispatch/<method>` with body `{ "input": … }` and the Location as
`?location[directory]=<dir>` or header `x-opencode-directory: <dir>`; the response is `{ output }`.
Targeting a worktree agent's directory boots (or reuses) that Location.

`session.lastResponse` reads the Session through the global store, so any Location can answer it.
Short replies (≤3 lines, ≤300 chars) are returned raw; longer ones are summarized with a one-turn
Haiku `query()` (`claude-haiku-4-5-20251001`, 15s) for Anthropic sessions, or the Session's small
(title) model at its own Location otherwise; on failure the first three lines come back.

## MCP, advisor and activity

- MCP reconnect and health live in core (`core/src/mcp/index.ts`, `client.ts`, marked `// Dispatch:`)
  because the connection table is private to `Mcp.Service`: an unexpected close retries after
  `[5s, 10s, 30s, 60s, 60s…]` until it connects, the entry is replaced, it needs auth or the user
  disconnects it; transport errors close the client once connected so `onclose` fires; `health()`
  pings each connected server (5s) and restarts unresponsive ones. Connect/disconnect state is the
  entry status, so a user `connect` overrides config `disabled` and `disconnect` stops retries.
  Start/stop already publish `mcp.tools.changed`.
- `advisor` is set with `config.update({ advisor })` (`PATCH /api/experimental/config`, `null`
  clears). The update rewrites the global config and reloads Config in every Location through its
  file watch; it does not reload Locations, and the runner reads `advisor` on every turn.
- Busy activity ("Shell pwd", "Thinking…") is derived on the client, no extra event: remember
  `session.tool.input.started` `{ id, name }`, show name + the main input field on
  `session.tool.called` `{ id, input }`, clear on `session.tool.success`/`failed`; show "Thinking…"
  between `session.reasoning.started` and `ended`. For a session already running when the dashboard
  opens, use its last assistant message's `running`/`streaming` tool part.

## Claude Agent SDK runner

Sessions whose resolved model is on the `anthropic` provider run through
`@anthropic-ai/claude-agent-sdk` `query()`; everything else delegates to the stock runner.

**This intentionally deviates from the root AGENTS.md rule "one explicit `llm.stream` per provider
turn, no in-memory tool loop".** The SDK owns the tool loop and its built-in tools. One drain turn is
one `query()` (resumed from the stored SDK conversation) that may span many provider calls. The v2
invariants that still hold:

- The runner owns the inbox exactly like `core/src/session/runner/llm.ts`: `nextPromotable` /
  `promote`, compaction and move controls, `InstructionState.prepare`, title generation on first
  promotion, `LocationLifecycle.isClosed()` → `Reloaded`. Steers that arrive while a query runs are
  promoted after it ends and answered by the next `query()`.
- Each SDK API call (one `message.id`) is one v2 assistant message with its own
  `createLLMEventPublisher`, exactly one `step-finish` and one `Step.Ended`. Tokens on a message are
  that call's usage (replaced, never summed across frames), so the TUI context gauge reads the latest
  call. The SDK result's cumulative totals are not written anywhere.
- Every tool is provider-executed. Results come from the SDK's `tool_result` blocks and are
  published on the message that published the call. Tool part names and inputs use the v2 vocabulary
  (`shell`, `read`, `write`, `edit`, `subagent`, `question`, `<server>_<tool>` for MCP).
- Agent/Task subagents write into child Sessions (`metadata.sessionID` on the parent's `subagent`
  part). PreToolUse forces them to run synchronously and applies the parent's rules to their calls.
- PreToolUse also forces `Bash` `run_in_background` to false, on the main thread and in subagents: a
  one-shot `query()` kills background shells a few seconds after its result, so they never finish.
- Interrupting the drain aborts the CLI and settles open messages as aborted.

### Callbacks and the Effect boundary

`canUseTool`, hooks and MCP request handlers run on the CLI's control channel, outside any fiber.
The runner layer captures its context once (`Effect.context()`) and every callback runs through
`Effect.runPromiseWith(context)`. Never reach for ambient state. Any service a callback needs must be
in the runner node's `deps`, or the captured context will not contain it.
`test/boundary.test.ts` guards this.

`Permission.Service.assert` turns a plain decline into a defect (`DeclinedError`); the bridge runs it
under `Effect.exit` and answers the SDK with `interrupt: true`, matching v2's "a decline ends the
step". `CorrectedError` (decline with feedback) is returned to the model as feedback.

### Session resume

`src/sdk/session-map.ts` keeps `{ sessionID, uuid, cwd }` under `Session.metadata["dispatch.sdk"]`.
Children and forks inherit metadata, so an entry is only honoured by the Session it names. Resume
always uses the stored `cwd`. A "No conversation found" failure before any output drops the entry and
retries without resume.

### Models and single-shot calls

`src/plugin/models.ts` enables the `anthropic` provider without credentials (the CLI falls back to
the Claude Code login), adds the static models from `src/sdk/models.ts` and points every Anthropic
model at the AI SDK package `aisdk:@opencode/dispatch/claude-agent-sdk`. The plugin answers that
package with `src/sdk/language-model.ts`, a one-turn tool-free `query()`, so title generation,
`generate` and summary compaction work on a subscription. `core/src/plugin/provider/dynamic.ts`
skips `@opencode/dispatch/*` packages (marked `// Dispatch:`) so it never tries to npm-install them.
Catalog models an alias already covers (its `catalog` field) are marked `deprecated`, so the picker
lists only the alias (with its `[1m]` opt-in) while saved references still resolve.

`InstructionBuiltIns.sdkSkipped` (`core/date`, `core/environment`, `core/codemode`) is left out of
every SDK request: the runner's system prompt and `core/src/session/generate.ts` (`/btw`) for
Anthropic models. Anthropic rejects a subscription request carrying opencode's `<env>` block with
"400 Third-party apps now draw from extra usage". `sdk/language-model.ts` turns the CLI's
`API Error: <status>` text into an `APICallError`, so a 400 fails at once instead of being retried.

### Embedded CLI binary

`src/sdk/bin.ts` `resolveClaudeBin()` loads `src/sdk/bin.gen.ts` when a release build injects it
(default export: the Bun-embedded path of the platform `claude` binary) and extracts it from `$bunfs`.
In dev the module is absent and the SDK resolves its own binary.

## claude.ai mirroring bridge

`src/bridge/service.ts` (`DispatchBridge`, a global node) attaches Sessions to claude.ai/code through
the SDK's alpha `@anthropic-ai/claude-agent-sdk/bridge`. The mapping `{ codeSessionID, mark }` lives
in `Session.metadata["dispatch.bridge"]`; live handles and pending remote prompts are module maps in
`src/bridge/mirror.ts`. `src/bridge/rpc.ts` registers RPC id `dispatch-bridge` (not `dispatch`: one
id resolves to its last registration only) in every Location; the runner node lists both nodes in its
deps so they are built. Runner hook points are marked `// Dispatch bridge:` in `runner/node.ts` and
`runner/permission.ts`. Inbound phone prompts switch the Session to the `yolo` agent when it exists.

## Tests

`bun test` from this directory. `test/preload.ts` points HOME/XDG at a temp dir. Writer and router
tests project through the real Bus and SessionProjector; permission tests use a real Location graph.
