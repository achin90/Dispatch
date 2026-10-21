# @opencode/dispatch

Dispatch's fork code. It plugs into v2 through extension points; upstream files are only touched at
registration points, each marked `// Dispatch:`.

## Wiring

- `src/overrides.ts` is the list of layer replacements `packages/server/src/process.ts` passes to
  `createRoutes(...)`. Every server entry (`serve`, `serve --stdio` behind `--standalone`, the
  managed service) goes through `ServerProcess.start`, so these apply to every Location.
- `src/runner/node.ts` replaces `SessionRunnerLLM.node`. It depends on a fresh copy of the stock node
  (`SessionRunnerLLM.node.mapLayer((layer) => layer)`): the replacement map keys on node identity, so
  depending on the original would resolve back to the replacement.
- `src/plugin/register.ts` replaces the host `SdkPlugins` store with one seeded with Dispatch's
  server plugins (`define()` from `@opencode/plugin/effect/plugin`). Add new Dispatch plugins to its
  `plugins` list. They activate after the internal `pre` plugins and before `post` (config) plugins.

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
