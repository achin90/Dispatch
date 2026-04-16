# Upstream Sync Workflow

Dispatch is a fork of [opencode](https://github.com/anomalyco/opencode). This document describes how to keep Dispatch in sync with upstream changes.

## Setup

**Remotes:**
- `origin` — `https://github.com/DemonicEgg/Dispatch.git` (Dispatch fork)
- `upstream` — `https://github.com/anomalyco/opencode.git` (upstream opencode)

**Primary branch:** `claudesdk` — all Dispatch development happens here.

**Strategy:** Merge-based workflow with `git rerere` for automatic conflict resolution.

## Syncing Upstream

```bash
git fetch upstream
git merge upstream/dev
```

`rerere` is enabled and will auto-resolve conflicts it has seen before. Only genuinely new conflicts require manual resolution.

## Resolving Conflicts

When conflicts arise during a merge:

1. **Understand both sides.** For each conflicted file, check what upstream changed vs what Dispatch changed. Use `git log upstream/dev --oneline -- <file>` and `git log --oneline -- <file>` to understand the history.

2. **Keep Dispatch features.** The goal is always: bring in upstream architectural/system upgrades while preserving ALL Dispatch features.

3. **Watch for overlapping implementations.** If upstream now implements something Dispatch added custom code for, migrate Dispatch to use upstream's version instead of maintaining a parallel implementation.

4. **Run typecheck after resolving.** From `packages/opencode`: `bun typecheck`

5. **Commit the merge.** `rerere` will record your resolutions for next time.

## Known Dispatch-Specific Features to Preserve

These features exist only in Dispatch and must survive every upstream merge:

- **Claude Agent SDK integration** — `claude-sdk-query.ts`, `claude-sdk-processor.ts`, `claude-sdk-adapter.ts`, `claude-sdk-session-map.ts`, `claude-sdk-permissions.ts`
- **Agent dashboard / multi-agent** — `routes/home.tsx` (agent list, worktree creation, PR integration, diff stats)
- **Worktree support** — `worktree/index.ts`, worktree agent context in `system.ts`
- **Static SDK model definitions** — `provider/provider.ts` (`SDK_MODELS`, `buildSdkModel`)
- **Activity display** — `formatActivity()` in `processor.ts`, `activity` field on `SessionStatus`
- **Cross-directory event bridge** — `bus/global.ts` and `context/event.ts` (must accept events from all directories, not just the current project)
- **Permission merging** — `permission/index.ts` (`merge()`, global pending map)
- **Queued message handling** — `prompt/index.tsx` and `session/prompt.ts` (cancel + restore)
- **Dashboard keybinds** — Leader key guard on escape in `permission.tsx`, `question.tsx`
- **Yolo agent** — `agent/agent.ts` (auto-approve permissions)
- **Custom commands** — `/merge` in `routes/home.tsx`
- **Agent summaries** — `component/agent-summaries.tsx`
- **Draft restore** — `routes/session/index.tsx` (save/restore prompt draft when permission dialog appears)

## Known Pitfalls

### Event filtering drops agent session updates
Upstream's `useEvent()` hook in `context/event.ts` filters events by directory. Agent sessions running in worktree directories publish events under their worktree path, not the main project directory. The filter must accept events from all directories or agent session updates will be invisible to the TUI.

### Agent session directory context lost on merge
Upstream's `session.ts` routes call `SessionPrompt.Service.use(...)` / `AppRuntime.runPromise(...)` directly — there is no concept of per-session directory context. Dispatch wraps every one of these calls with `withSessionDirectory(sessionID, () => ...)` (defined at the top of `server/instance/session.ts`), which looks up the session's stored directory and runs the operation inside `Instance.provide({ directory: session.directory, ... })`. This is essential for agent sessions that run in worktree directories; without it, tools, system prompts, and file operations resolve against the TUI's startup directory instead of the agent's worktree.

**What to watch for during merges:**
- Any new or modified route handler in `session.ts` that calls `SessionPrompt` methods (`prompt`, `cancel`, `loop`, `command`, `shell`) must be wrapped with `withSessionDirectory`.
- Upstream may refactor how `SessionPrompt` is invoked (e.g., switching from `AppRuntime.runPromise(SessionPrompt.Service.use(...))` to a different Effect pattern). Regardless of the calling convention, the `withSessionDirectory` wrapper must remain.
- If upstream adds entirely new session routes, they also need the wrapper if they perform any work scoped to a session's directory.

**Quick verification after merge:**
```bash
# Every SessionPrompt call in session.ts should be inside withSessionDirectory
grep -n "SessionPrompt\." packages/opencode/src/server/instance/session.ts
grep -n "withSessionDirectory" packages/opencode/src/server/instance/session.ts
# The counts should roughly match — each SessionPrompt call needs a wrapper
```

### SessionStatus endpoint misses worktree agent activity
The `/session/status` endpoint in `session.ts` calls `SessionStatus.list()` without `withSessionDirectory`. Because `SessionStatus` uses `InstanceState.make()` (keyed by Instance directory), agent sessions running in worktrees store their status under the worktree's Instance — but the endpoint reads from the TUI's startup directory Instance. Real-time events work (GlobalBus broadcasts everywhere), but the initial bootstrap fetch at TUI startup returns empty status for worktree agents.

**Symptom:** Agent activity ("Thinking...", "Bash pwd", etc.) shows up momentarily but disappears on page reload or is missing on initial load.

### Claude SDK token counting regresses to per-stream accumulation
Upstream's AI SDK path accumulates tokens from `finish-step` stream events (`processor.ts` line ~381). The Claude SDK path must NOT do this — it sets tokens once from the `SDKResultMessage.usage.*` totals in `processResultMessage()` (`claude-sdk-processor.ts` line ~651). During merges, if someone applies the AI SDK's per-event token pattern to the SDK processor, token counts become wrong (double-counted or missing cache tokens).

**What to watch for:** Any code that sets `assistantMessage.tokens` in the Claude SDK stream loop (before the result message) is a regression. Tokens should only be set in `processResultMessage()`.

### Custom commands (/deepReview, /merge) removed during merge
Upstream only defines `/init` and `/review` in `command/index.ts`. Dispatch adds `/deepReview` and `/merge`. These are defined in `Command.Default` and initialized in the Effect layer. During merges, the command definitions and their template imports (`PROMPT_MERGE`, `PROMPT_DEEP_REVIEW`) can be lost.

### Keybind guards removed from permission/question prompts
Dispatch guards escape/app_exit handling in `permission.tsx` and `question.tsx` with two checks: (1) `shouldSkipKeyboard(dialog.stack.length)` — skip all keys when a dialog is open, and (2) `shouldProcessEscape(keybind.leader, evt.name)` — don't process escape when leader mode is active. These are extracted into `guards.ts`. Upstream has no concept of leader mode or dialog stacks in these prompts, so merges often remove these guards.

**Symptom:** Pressing escape with command palette open dismisses the permission prompt. Leader+escape rejects the permission instead of navigating to dashboard.

### Draft save/restore logic lost or broken
Dispatch saves the prompt draft when permission dialogs appear (Prompt unmounts) and restores it when they dismiss (Prompt remounts). The logic uses `shouldSave()`, `resolve()`, and `shouldBlock()` from `draft.ts`. Upstream has no draft persistence across permission dialogs. The auto-submit prevention (`shouldBlock`) is critical — without it, the Enter key that navigated into the session auto-submits the restored draft.

**Symptom:** Typed text disappears when a permission dialog appears. Or, restored draft auto-submits immediately without user confirmation.

### Effect framework migrations
Upstream is actively migrating to Effect's `Context.Service` pattern (from the older `ServiceMap.Service`). When merging, watch for:
- `ServiceMap` imports that need to become `Context`
- `InstanceState.withALS` calls that were removed (use direct service calls instead)
- Facade functions that were removed (upstream removes `runPromise` wrappers as they migrate to full Effect)
- `Layer.unwrap(Effect.sync(...))` → `Layer.suspend(() => ...)`

### Server API changes
Upstream changed `Server.Default()` to return `{ app, runtime }` instead of just the Hono app. Tests that call `Server.Default()` need `.app`.

## Dispatch Regression Tests

These test files specifically guard Dispatch features against upstream merge regressions. **Run them after every merge:**

```bash
cd packages/opencode && bun test \
  test/session/format-activity.test.ts \
  test/permission/next.test.ts \
  test/server/session-directory.test.ts \
  test/server/session-creation-directory.test.ts \
  test/server/event-cross-directory.test.ts \
  test/provider/sdk-models.test.ts \
  test/claude-sdk/adapter.test.ts \
  test/claude-sdk/error-extraction.test.ts \
  test/claude-sdk/token-counting.test.ts \
  test/claude-sdk/session-map.test.ts \
  test/claude-sdk/pending-meta.test.ts \
  test/command/dispatch-commands.test.ts \
  test/cli/tui/guards.test.ts \
  test/cli/tui/draft.test.ts \
  --timeout 30000
```

| Test file | Guards |
|-----------|--------|
| `test/session/format-activity.test.ts` | `formatActivity()` in both AI SDK and Claude SDK processor paths |
| `test/permission/next.test.ts` (new tests at end) | `fromConfig` + `merge` with mixed string/object permission forms |
| `test/server/session-directory.test.ts` | `withSessionDirectory` wrapper on all session routes (abort, prompt, command, shell) |
| `test/server/session-creation-directory.test.ts` | Sessions store their creation directory, retrievable from any Instance context |
| `test/server/event-cross-directory.test.ts` | GlobalBus cross-directory event bridge and duplicate prevention |
| `test/provider/sdk-models.test.ts` | `SDK_MODELS` definitions and `buildSdkModel` output (family, description, capabilities) |
| `test/claude-sdk/adapter.test.ts` | `normalizeTool`, `snakeToCamel`, `normalizeInput` — SDK→TUI data transformation |
| `test/claude-sdk/error-extraction.test.ts` | `extractErrorMessage` — HTTP status detection and error shape handling |
| `test/claude-sdk/token-counting.test.ts` | Tokens set from SDK result totals, not accumulated per-stream-event |
| `test/claude-sdk/session-map.test.ts` | SDK session UUID persistence (set/get/remove/disk) |
| `test/claude-sdk/pending-meta.test.ts` | `popPendingMeta` pop semantics for race-condition metadata |
| `test/command/dispatch-commands.test.ts` | `/deepReview` and `/merge` command constants and `hints()` utility |
| `test/cli/tui/guards.test.ts` | Dialog-open and leader-mode keybind guards (prevent escape dismissing wrong prompt) |
| `test/cli/tui/draft.test.ts` | Draft save/restore lifecycle, auto-submit prevention, permission dialog cycle |

## Verifying a Merge

After resolving conflicts:

```bash
# 1. Typecheck
cd packages/opencode && bun typecheck

# 2. Run Dispatch regression tests (211 tests across 14 files)
bun test test/session/format-activity.test.ts test/permission/next.test.ts \
  test/server/session-directory.test.ts test/server/session-creation-directory.test.ts \
  test/server/event-cross-directory.test.ts test/provider/sdk-models.test.ts \
  test/claude-sdk/adapter.test.ts test/claude-sdk/error-extraction.test.ts \
  test/claude-sdk/token-counting.test.ts test/claude-sdk/session-map.test.ts \
  test/claude-sdk/pending-meta.test.ts test/command/dispatch-commands.test.ts \
  test/cli/tui/guards.test.ts test/cli/tui/draft.test.ts \
  --timeout 30000

# 3. Verify Dispatch features are present
grep -r "formatActivity" src/session/processor.ts    # Activity display
grep -r "claude-agent-sdk" src/session/              # Claude SDK
grep -r "AgentEntry" src/cli/cmd/tui/routes/home.tsx # Dashboard
grep -r "withSessionDirectory" src/server/instance/session.ts  # Directory context

# 4. Check logs after running (logs at ~/.local/share/opencode/log/)
tail -f ~/.local/share/opencode/log/dev.log
```

## Release Cleanup (Optional)

For a clean release history, do a one-time rebase:

```bash
git checkout -b release-clean claudesdk
git rebase upstream/dev
# rerere auto-resolves most conflicts
```

This is optional — the merge-based history is fine for day-to-day development.
