# Dispatch → opencode v2 migration plan

Status: Phases 0–3 done; Phase 4 verification is in progress (see "Phase 4 record"). Phases 1–4 were executed by implementation agents, in order. Every agent reads this file plus `01-v2-new-features.md`, `02-v2-architecture-map.md`, `03-dispatch-v1-inventory.md` before touching code.

## Ground truth

- Branch `Dispatch-opencodev2` tree == `upstream/dev` (opencode 2.1.2) + Dispatch docs. Commit `a27db4d6bf` is a merge with both parents, so future `git merge upstream/dev` is incremental.
- The old fork (v1) is tagged **`dispatch-v1-final`**. Read any old file with `git show dispatch-v1-final:<path>`. Never check that tag out.
- `packages/opencode` no longer exists. v1 → v2 package map is in `02-v2-architecture-map.md` §1.
- Baseline: `bun install` ok, `bun run dev --version` prints `opencode vlocal`. Baseline typecheck result is recorded in §Phase 0.

## Rules for every agent

- Repo rules: root `AGENTS.md` (style, imports, Effect patterns, no `tsc` directly, tests only from package dirs, conventional commit titles `type(scope): summary`). No Claude/AI attribution anywhere in commits. Use `rg`, never grep/find.
- Dependency direction: Schema → Core/Protocol → Server; Client never imports Core/Server. `ai` never imports `core`.
- Prefer putting fork code in **`packages/dispatch`** (new workspace package, `@opencode/dispatch`) and in TUI feature-plugins, and wiring it through the extension points v2 provides (server plugins `define()`, `Rpc.register`, layer replacements via `createRoutes(..., overrides)`, TUI `feature-plugins`). Edit upstream files only at registration points or where no extension point exists; keep each upstream edit small and marked with a `// Dispatch:` comment so the next upstream merge can find it.
- After changing anything under `packages/protocol` or server `HttpApi`: `cd packages/client && bun run generate`. Prefer `Rpc.register` for fork-only endpoints so this is rarely needed.
- Custom bus events must be registered in `packages/schema/src/event-manifest.ts` or emitted through `Rpc` events, or the SSE feed drops them.
- Logging: Effect `Effect.log*` only. From plain async code (SDK callbacks) use a context captured inside the layer (`Effect.runForkWith(ctx)` / `Effect.runPromiseWith(ctx)`). No ALS, no `Instance.restore`.
- Definition of done for every task: typecheck passes in every touched package (`bun typecheck` from the package dir), tests you added pass (`bun test <file>` from the package dir; core uses `bun run script/test.ts`), and the work is **committed** on this branch with a conventional-commit message. Report what you verified and how.
- Verification that doesn't need a terminal: `bun run dev run --standalone --auto -m anthropic/<model> "prompt"` (non-interactive, goes through the real server + runner). `bun run dev --standalone` boots the TUI with a private server.
- When an inventory item says a v1 behaviour was "lost or broken in the tree" or "vestigial", don't port it.

## Triage: what is superseded by v2 (do NOT port)

| v1 Dispatch feature | v2 replacement | Note |
|---|---|---|
| `withSessionInstance` / `withSessionInstanceOptional` | `SessionLocationMiddleware` runs session routes at the session's location | nothing to do |
| Cross-directory event bridge (`handlers/event.ts`, `bus/global.ts`) | `EventFeed` is already unfiltered across locations; TUI filters client-side | verify TUI dashboard sees events from worktree sessions |
| Permission `globalPending` | `session.permission.reply` is under `sessionLocationMiddleware`, so reply resolves the session's location | nothing to do |
| Question global `index` | Forms (`Form.Service`) + `FormLocationMiddleware` | SDK `AskUserQuestion` maps to a form |
| Queued messages, UNSENT badge, leader+u undo, `cancel` single-message restore | inbox steer/queue, `<leader>q`, Ctrl+U/Ctrl+D | nothing to do |
| `util/pty.ts` PTY attach (`t` key) | persistent terminal pane (`<leader>t`) | dashboard `t` opens the session and toggles its terminal pane |
| `routes/diffview.tsx` (`D` key) | v2 `/diff` viewer (docked, `f` fullscreen, sources) | dashboard `D` opens the session's diff viewer |
| Draft save/restore (`draft.ts`, `bind`/`boundSessionID`) | v2 per-tab prompt drafts; verify the permission prompt no longer unmounts the composer | drop unless verification shows typed text is lost |
| Plan-mode leftovers (`tool/plan.ts`, `plan.txt`, ExitPlanMode 3-way switch) | plan is a v2 plugin agent | Dispatch hides the `plan` agent (user removed plan mode in favour of `assistant`) |
| `cli/upgrade.ts` early return | v2 managed updater service | disable the updater for the Dispatch build (§2C) |
| `claude-sdk-session-map.ts` side file | `Session.metadata` (if writable via API) else a `dispatch_sdk_session` table | survives session moves |
| `util/log-bridge.ts` | Effect logging with captured context | — |
| `# Worktree Agent Context` block in `session/system.ts` | — | already marked not-must-preserve |
| `--standalone` (skip dashboard) | **collides** with upstream `--standalone` (private server) | rename to `--no-dashboard` |
| `/merge` command's `${path}` replace, `dialog-prompt.tsx` `mounted`, kv `agents` unused | vestigial | drop |
| MCP enable of config-disabled servers from the MCP dialog | superseded: upstream `Mcp.connect()` bypasses the `disabled` flag; 2A's reconnect loop keeps the override; the SDK proxy excludes `disabled` servers (commit 6d718c110b) | verified live in Phase 4 |
| 5 "lost or broken" items in inventory (editor repaint order, string/object permission merge, small-model fallbacks, compaction `info &&` guard, undo guard) | — | drop |

## Triage: decide with a check (agent records the answer in its report)

- **MCP scope:** start with upstream's per-location `Mcp.Service`. Keep the fork invariants that don't depend on scope: fresh proxy server object per SDK session, tool-definition cache with fallback on failed `listTools`, status check before call, `strictMcpConfig: true`, `ENABLE_TOOL_SEARCH=false`. Add auto-reconnect with backoff + `onerror → close` + a health check (v2 has none). Revisit global scope only if worktree agents visibly lose servers.
- **Activity string on busy status** (`formatActivity`): check whether v2 session status/`activity-summary.ts` already shows "Bash pwd"/"Thinking…"-style activity for a session; if yes use it, else add `activity` to the SDK runner's status event and the dashboard.
- **Reject-with-reason:** check v2 `routes/session/permission.tsx`; if `reject` can reply without a message, route it through the reason stage like v1.
- **Dashboard persistence:** prefer `Session.metadata` for agent entries (works from web/mobile) if metadata is writable through the API; else the TUI KV store (keep the read-merge-write fix).
- **Worktree naming:** v2 creates detached worktrees under `<data>/worktree/<project>`; PR creation needs a named branch. Implement as a Dispatch worktree strategy (plugin `ctx.worktree`) that creates `<parent-dir>/<repo>-<slug>` with branch `<slug>` (no `opencode/` prefix). If the strategy API can't name branches, fall back to a minimal edit in `core/src/worktree/strategies.ts` marked `// Dispatch:`.
- **Single-shot model calls** (title, compaction summary, `/btw`, `generate`): these use `llm.stream` with a real API key. Subscription-only users (our main case) need an SDK-backed `LanguageModel`. Phase 1 decides: ship a tiny provider package in `packages/dispatch` whose `model()` runs a 1-turn `query()` with tools disabled, so `Model.Info.package` resolves and every single-shot caller works.

## Port list

### Phase 1 — Claude Agent SDK runner (one agent, serial, foundation)

Source: `git show dispatch-v1-final:packages/opencode/src/session/claude-sdk-{query,processor,adapter,permissions,session-map,bin}.ts`, `session/prompt.ts` (~1200–1470), `session/compaction.ts` (~430–660), `provider/provider.ts` (`SDK_MODELS`, `buildSdkModel`, `sdkProvider`), `provider/transform.ts` (effort variants), tests under `packages/opencode/test/claude-sdk/*`, `test/provider/sdk-models.test.ts`, `test/permission/subagent-hook.test.ts`.

Deliverables (in `packages/dispatch` unless noted):
1. **Verify the override path**: a replacement for `SessionRunnerLLM.node` passed via `createRoutes(options, serviceURLs, overrides)` reaches `Instance.layer(ref, { replacements })` and is used for every location. Wire it from `packages/server/src/process.ts` (and the stdio/standalone path the CLI uses). Prove with a log line before porting anything.
2. **SDK runner**: decorates `SessionRunnerLLM.node`; `drain` loads the session context, and if the model's `providerID === "anthropic"` (or a Dispatch marker on `Model.Info`) runs the SDK path, else delegates to the stock runner. Owns the inbox (`nextPromotable`/`promote`, steers delivered between SDK turns), title generation on first promotion, `LocationLifecycle.isClosed()` → `Reloaded`, stale tool/compaction settlement (copy the un-exported helpers), interrupt via `onInterrupt` aborting the `query()`.
3. **Message writing**: one `createLLMEventPublisher` per SDK assistant message; all tools `providerExecuted: true`; exactly one `step-finish` per message; `Step.Ended` with tokens set **once** from `SDKResultMessage.usage` (never accumulated); reasoning duration window; subagent (`Task`/`Agent`) child sessions with `metadata.sessionID` so the subagents tab works; `task_started/progress/notification`; compaction boundary → `SessionMessage.Compaction`. Tool/permission vocabulary renamed to v2: `bash→shell`, `task→subagent`, `write/patch→edit`, rules `{action, resource, effect}`. Adapter: `normalizeTool`, `snakeToCamel`, `normalizeInput`, advisor blocks (`server_tool_use name:"advisor"` → tool part; `advisor_tool_result` completes it).
4. **Permissions bridge**: `canUseTool` → `Permission.Service.assert` wrapped in `Effect.exit`/`catchDefect` (a decline is a defect upstream); `CorrectedError` feedback → "User rejected permission with the following feedback: …"; external-directory gate; edit/write diff metadata stashed before approval (`popPendingMeta`); `PreToolUse` hook forcing `run_in_background: false` on `Agent`/`Task` and propagating the parent ruleset (deny wins, all-allow allows, else ask); `AskUserQuestion` → `Form.Service.ask` with `metadata.kind: "question"`.
5. **Query construction**: env `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, `ENABLE_TOOL_SEARCH=false`, resolved `ANTHROPIC_API_KEY` (env, else credential store api key, else OAuth); `permissionMode: "default"`; `strictMcpConfig: true`; `settings.autoCompactWindow = clamp(contextWindow, 100k, 1M)`; `settings.advisorModel` from config `advisor` (global, live); resume `{uuid, cwd}` stored in `Session.metadata` (stale-session retry without resume); media parts → `SDKUserMessage` image/document blocks; system prompt = agent system + skills + instructions (no environment block); MCP proxies (fresh `createSdkMcpServer` per session from cached defs; status check before call); plugin tools exposed as an in-process MCP server `opencode-plugins`.
6. **Models**: Dispatch provider plugin adding the static SDK models to `anthropic`: `default`(hidden), `fable-5-1`, `opus-5-5` (default, 1M, `[1m]`), `opus-4-6[1m]`, `sonnet` (native 1M, no suffix), `haiku`; `sdkDescription`; effort variants `low/medium/high/xhigh/max` for summarized-thinking models; keep every 1M Opus id suffixed `[1m]`. Plus the SDK-backed `LanguageModel` package for single-shot callers (see triage).
7. **Compaction**: SDK `/compact` path with `PostCompact` hook; emits a Compaction message; tokens reset.
8. **Tests** (in `packages/dispatch/test`): adapter mapping, token counting (result totals only), permission bridge once/always/reject/abort/feedback, subagent hook, sdk-models, and a **boundary test**: a callback invoked outside any Effect fiber reaches `Permission.Service` for the right location (the v2 analog of `instance-boundary.test.ts`).
9. **Divergence note** in `packages/dispatch/AGENTS.md`: the SDK owns the tool loop; this intentionally deviates from the root AGENTS.md "one `llm.stream` per step" rule for Anthropic sessions.

Done when: `bun run dev run --standalone --auto -m anthropic/opus-5-5 "list files in this directory with a tool then summarize"` streams text, shows a tool call and a result, records tokens; a second `run -s <id>` resumes the SDK session; a `run` without `--auto` that triggers a permission is approved through the API (`session.permission.reply`); the boundary test passes.

### Phase 2 — parallel streams (after Phase 1 is round-tripped)

**2A Dispatch server plugin** (`packages/dispatch`, registered as an internal plugin):
- Agents: `build` (asks on shell/edit), `yolo` (`*` allow), `assistant` (`*` allow + `assistant.txt` prompt — port it); hide `plan`; order build→yolo→assistant. Source: `agent/agent.ts` ~142–186, `agent/prompt/assistant.txt`.
- Commands: `/deepReview`, `/merge` with `$ARGUMENTS` (`command/template/{deep-review,merge}.txt`).
- Worktree strategy: sibling directory `<repo>-<slug>`, named branch `<slug>` (see triage).
- RPC endpoints (via `Rpc.register`, emitting `rpc.*` events): `gitRepos.list({root, query})`, `github.status`, `github.pr({branch, cwd})`, `github.createPr`, `github.mergePr`, `worktree.info/diff/diffstat({directory})` (reuse v2 `vcs.diff` where it fits), `session.lastResponse` (raw text if ≤3 lines/300 chars, else Haiku summary via 1-turn `query()`; prompt-injection-safe template from `session/summarize.ts`), `mcp.health`.
- MCP: reconnect with backoff `[5s,10s,30s,60s,60s…]`, `onerror → close`, enabled override persisted on connect/disconnect, tools-changed on connect/disconnect, health check recreating unresponsive clients. Source: `mcp/index.ts` ~500–560, ~767–790, ~1106.
- Config: `advisor` key (global, live; `off`/unset disables). Source: `packages/core/src/v1/config/config.ts` + `handlers/global.ts` LIVE_GLOBAL_KEYS idea — in v2 find the equivalent of a live config update that doesn't reload locations.

**2B TUI** (`packages/tui`, as feature-plugins where possible):
- Agent dashboard as the home route when more than zero agents exist or always (user can veto): `AgentEntry` list, status column (Approve y/n, Waiting, Working + activity, Retrying; recurse into child sessions), detail rows (permission detail with command/diff, agent summary), diffstat per directory group, PR status polling (300s), keys `j/k/↑/↓`, `1-9/0`, enter, `c` copy path, `a` new agent (directory picker), `w` new worktree agent (repo picker), `d` remove, `x` delete worktree, `D` diff, `y/n` approve/deny, `t` terminal, `i` inline prompt, `r` refresh, `P` create PR, `o` copy PR url, `M` merge PR; footer hints; `<leader>d` back to dashboard from a session; agent name carried into the session title. Source: `routes/home.tsx` (1138 lines), `component/dialog-git-repo-select.tsx`, `dialog-directory-select.tsx`, `component/agent-summaries.tsx`, `config/keybind.ts` dashboard binding.
- Inline dashboard prompt uses the agent's directory for `@file` autocomplete and slash commands.
- Advisor dialog `/advisor` (Off / Fable / Opus / Sonnet) reading/writing the global `advisor` config. Source: `component/dialog-advisor.tsx`, `app.tsx` command `advisor.list`.
- `--no-dashboard` flag (was `--standalone`): skip dashboard, open a session directly, hide the dashboard hint.
- Checks from triage: reject-with-reason, activity display, draft restore, dashboard persistence.
- Plugin state API: `TuiState.home.selectedSessionID()`, `TuiState.agent.{current,list,set}` (needed by Jarvis). Source: `packages/plugin/src/tui.ts`, `packages/tui/src/plugin/adapters.tsx`.
- Dashboard shows a `◉` indicator for mirrored (claude.ai) sessions once 2D lands.

**2C Packaging / CLI**:
- Binary name `dispatch` (keep `opencode` alias off), user agent `dispatch/<version>`, package `dispatch-tui` naming where v1 had it (`packages/cli/package.json`, `bin/`, `script/build.ts`).
- Embed the `claude` CLI binary from `@anthropic-ai/claude-agent-sdk-<os>-<arch>` in `packages/cli/script/build.ts` (v1: `claude-sdk-bin.gen.ts` injected file + `extractFromBunfs`); dev mode lets the SDK find its own binary. Source: `packages/opencode/script/build.ts`, `session/claude-sdk-bin.ts`, `script/postinstall.mjs`, `packages/opencode/bin/dispatch`.
- Service identity: Dispatch must not replace/clash with a stock `opencode` background service — give it its own channel/identity (`OPENCODE_CHANNEL`, service registration file/port) or default to private-server mode.
- Disable the managed updater and `/update`/`/highlights` for Dispatch builds.
- `install` / `install-from-source` scripts (releases from `github.com/achin90/Dispatch`, `~/.dispatch/bin`), `.github/workflows` repo guards (`if: github.repository == 'anomalyco/opencode'`) + `release.yml`, `bunfig.toml` `minimumReleaseAgeExcludes` for the SDK packages, `.gitignore` entries. Source: v1 root files + `.github/workflows/*`.
- `packages/script/src/index.ts` channel sanitization / `dispatch-tui` version lookup.
- README stays Dispatch's; update paths/commands for v2.

**2D claude.ai mirroring bridge**: port `session/claude-sdk-bridge.ts` (OAuth token from `~/.claude/.credentials.json` or macOS Keychain, `bridge-sessions.json` mapping, `attachMirror/detachMirror/getMirror`, backfill, echo suppression, inbound prompts as `yolo`, interrupt → `SessionExecution.interrupt`, permission/question fan-out, `safe()` wrappers) onto the v2 runner; RPC `session.remoteControl/remoteControlStop/remoteControlList`; TUI commands `/remote`, `/remote-stop`, `◉ remote` indicator; detach on session delete. Depends on Phase 1's permission/question bridge hooks.

### Phase 3
- **Jarvis voice plugin** (`packages/tui/src/feature-plugins/jarvis/*`, deps `sherpa-onnx-node`, `kokoro-js`, ffmpeg) — needs 2B's state API and dashboard events. Source: inventory §G Jarvis.
- **Tests**: port/replace the regression tests listed in inventory §I against the new modules.
- **Docs**: rewrite `UPSTREAM-SYNC.md` for the v2 layout (every path and grep in it is stale), update `CLAUDE-SDK-MIGRATION.md`, add the runner-divergence note to the root `AGENTS.md` (short), delete `PHASE-0-PLAN.md` if still present.

### Phase 4 — verification
- `bun typecheck` in core, server, cli, tui, dispatch, client; `cd packages/client && bun run generate` if protocol changed; package tests.
- Automated: `opencode run` round-trips on the SDK path and on a non-Anthropic model (AI path), permission reply through the API, form reply, resume, interrupt.
- Manual (ask the user): launch `bun run dev` TUI, create a worktree agent from the dashboard, approve its permission from the dashboard, confirm its tools run in the worktree, `t`/`D`/`i` keys, `/advisor`, `/remote`.

## Phase 0 record
- `git tag dispatch-v1-final 137879b0ef`; merge commit `a27db4d6bf` (parents `137879b0ef`, `3a1f9a934f`).
- `bun install`: ok (4281 packages).
- `bun run dev --version`: `opencode vlocal`.
- Baseline typecheck: see commit message of the docs commit / `/tmp/typecheck-baseline.log` at the time.

## Phase 4 record

Verified so far on `Dispatch-opencodev2`:

- `bun typecheck` in every touched package and `bun run check` at the root: clean.
- `packages/dispatch`: 123 tests pass (`bun test`).
- SDK session round trip on `anthropic/haiku`: a `write` permission was approved through the API (`POST /api/session/:id/permission/:id/reply {"decision":"once"}`), the file was written, each assistant message carried its own call's tokens, and the Session gained `dispatch.sdk` resume metadata.
- `dispatch` RPCs over `POST /api/rpc/dispatch/<method>` (`{"input":…}`, header `x-opencode-directory`): `gitRepos.list`, `worktree.info`, `worktree.diffstat`, `mcp.health`, `github.status`, `session.lastResponse`. `dispatch-bridge` RPC `session.remoteControlList`.
- Agents `build`, `yolo` and `assistant` are present and `plan` is gone. `/deepReview` and `/merge` are listed.
- Advisor set and clear through `PATCH /api/experimental/config` (`{"advisor":"…"}`, then `{"advisor":null}`) writes and then removes the key in `~/.config/opencode/opencode.json`.
- Enabling a config-disabled MCP server with `POST /api/experimental/mcp/:server/connect` connects it; `disconnect` sets it disabled again.
- Non-Anthropic routing: a session on `opencode/minimax-m3.1-flash-free` ran through the stock runner (no "starting claude agent sdk query" log line; it failed only on the free-tier gate).
- Dispatch worktree strategy: `POST /api/worktree {"projectID","name":"smoke-wt"}` created `/Users/andy/Documents/Dispatch-smoke-wt` on branch `smoke-wt`; a second create with the same name gave `Dispatch-smoke-wt-2` / `smoke-wt-2`; `DELETE /api/worktree` with `force` removed both directories and branches.
- Advisor live: with `advisor: "opus"` a `haiku` session asked to consult the advisor produced a completed `advisor` tool part. (With `advisor: "haiku"` on a haiku session the CLI silently skips it, as v1 documented: the advisor must be the more capable model.)
- Model picker shows the SDK model description from `settings.sdkDescription` (`component/dialog-model.tsx`).

Pending manual TUI pass (needs the user at a terminal, `bun run dev:live`):

- dashboard: create a worktree agent;
- approve a permission from the dashboard;
- dashboard keys `t` (terminal), `D` (diff), `i` (inline prompt);
- `/advisor`;
- `/remote`;
- Jarvis live voice.

Phase 3 docs: `UPSTREAM-SYNC.md` and `CLAUDE-SDK-MIGRATION.md` were rewritten for v2, and the root `AGENTS.md` gained a "Dispatch fork" section. `PHASE-0-PLAN.md` was already gone.
