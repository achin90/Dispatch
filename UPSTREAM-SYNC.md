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
- **Worktree support** — `worktree/index.ts` (sibling-path creation via `dirname`/`basename` of `ctx.worktree`; branch name without `opencode/` prefix), worktree agent context in `system.ts`
- **Static SDK model definitions** — `provider/provider.ts` (`SDK_MODELS`, `buildSdkModel`)
- **Activity display** — `formatActivity()` in `processor.ts`, `activity` field on `SessionStatus`
- **Cross-directory event bridge** — `bus/global.ts` and `context/event.ts` (must accept events from all directories, not just the current project)
- **Permission merging** — `permission/index.ts` (`merge()`, global pending map)
- **Question global pending map** — `question/index.ts` (`index` map, same cross-directory pattern as permissions)
- **Queued message handling** — `prompt/index.tsx` and `session/prompt.ts` (cancel + restore)
- **Dashboard keybinds** — Leader key guard on escape in `permission.tsx`, `question.tsx`
- **Yolo agent** — `agent/agent.ts` (auto-approve permissions)
- **Custom commands** — `/merge` in `routes/home.tsx`
- **Agent summaries** — `component/agent-summaries.tsx`
- **Draft restore** — `routes/session/index.tsx` (save/restore prompt draft when permission dialog appears)
- **MCP connection sharing + reconnect** — `mcp/mcp.ts` (`client.onerror` closes client to trigger reconnect), `claude-sdk-query.ts` (global MCP proxy cache shared across all agent sessions), `server/instance/mcp.ts` (`/mcp/health` endpoint)

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

**Two restore paths — both must set `restored = true`:**

1. **`bind` path** (`session/index.tsx`): `resolveDraft` returns `{ action: "draft", block: true }` → `r.set(draft, true)` → sets `restored = true` in the Prompt closure.
2. **`stashed` path** (`prompt/index.tsx` `onMount`): upstream's module-level `stashed` variable restores content when the Prompt remounts. This path must also set `restored = true` before calling `input.setText`.

In `@opentui/solid`'s custom renderer the ref callback (which calls `bind`) may fire **after** `onMount` rather than during the render phase. If `onMount` consumes `stashed` without setting `restored = true`, the Enter key that triggered navigation auto-submits the restored draft before `bind` has a chance to set the flag.

**Fix:** In `prompt/index.tsx` `onMount`, set `restored = true` before restoring from `stashed`:
```ts
if (saved && saved.prompt.input) {
  restored = true  // ← must be here
  input.setText(saved.prompt.input)
  ...
}
```

**Symptom:** Typed text disappears when a permission dialog appears. Or, restored draft auto-submits immediately without user confirmation (pressing Enter in the home dashboard to re-enter a session auto-sends the draft).

### Permission pending map scoped to InstanceState instead of global
Upstream stores the pending permission map inside `InstanceState`, which is keyed by Instance directory. Dispatch needs a **module-level** `globalPending` map so the TUI (running in the main project directory) can reply to permission requests raised by agent sessions in worktree directories. Without this, pressing y/n on a permission dialog from the dashboard does nothing — the TUI's InstanceState has an empty `pending` map because the request lives in a different directory's InstanceState.

**Design:**
- `globalPending` (module-level `Map<PermissionID, PendingEntry>`) holds ALL pending entries across all directories.
- Each `PendingEntry` captures the `approved` ruleset from the agent's InstanceState at `ask()` time, so `reply()` doesn't need to resolve its own InstanceState.
- Each instance tracks which entries it owns via `ownedPending: Set<PermissionID>` in the State interface, so the finalizer on instance dispose only rejects its own entries.
- `list()` reads from `globalPending` (returns all entries globally).
- `reply()` reads from `globalPending` directly — no InstanceState.get needed.

**Symptom:** Pressing y/n to approve/deny permissions from the dashboard (home screen) does nothing. The permission dialog stays visible indefinitely.

**Quick verification after merge:**
```bash
# globalPending should exist at module level, not inside InstanceState init
grep -n "globalPending" packages/opencode/src/permission/permission.ts
# Should see: const globalPending = new Map<...>(), and uses in ask/reply/list
```

### Question pending map scoped to InstanceState instead of global
The same issue as permissions applies to the Question service (`question/index.ts`). Upstream stores the pending question map inside `InstanceState`, which is keyed by directory. The `ask()` call runs in the agent's directory context (via `Instance.bind` in `claude-sdk-permissions.ts`), but `reply()` runs in the TUI's directory context (via the HTTP middleware). These resolve to different `ScopedCache` entries, so `reply()` can never find the pending request.

This affects **both single-question and multi-question prompts** — any question routed through the AskUserQuestion bridge will be invisible to `reply()`/`reject()` if the directory contexts differ.

**Design:**
- `index` (module-level `Map<QuestionID, PendingEntry>`) holds ALL pending entries across all directories.
- Each instance still has its own `pending` map in `InstanceState` for finalizer cleanup (reject owned entries on dispose).
- `ask()` stores in both `pending` (per-instance) and `index` (global). Cleanup (`Effect.ensuring`) deletes from both.
- `reply()`, `reject()`, and `list()` read from `index` directly — no `InstanceState.get` needed.
- The finalizer iterates `state.pending.entries()` to reject owned entries and cleans them from `index`.

**Symptom:** The question dialog (single or multi) appears but pressing Enter to submit or Escape to dismiss does nothing. The HTTP reply returns 200 but the Question service logs `"reply for unknown request"`. The dialog stays visible indefinitely.

**Quick verification after merge:**
```bash
# index should exist at module level, not inside InstanceState init
grep -n "const index" packages/opencode/src/question/index.ts
# reply/reject/list should use index, not InstanceState.get
grep -n "index.get\|index.delete\|index.values" packages/opencode/src/question/index.ts
```

### Worktree path created in central data directory instead of as sibling
Upstream creates new worktrees under `~/.local/share/opencode/worktree/<projectId>/<slug>`. Dispatch creates them as siblings of the parent worktree so the directory structure is intuitive (e.g., `/projects/BillingService` → `/projects/BillingService-feature-name`). During merges, `makeWorktreeInfo` in `worktree/worktree.ts` can revert to using `Global.Path.data` as the root instead of `pathSvc.dirname(ctx.worktree)`.

**Design:**
- `root` = parent directory of the current worktree (`pathSvc.dirname(ctx.worktree)`)
- `base` = `<currentWorktreeBasename>-<slugifiedName>` (or just `<currentWorktreeBasename>` when no name is given, which triggers the collision-avoidance loop to append a random slug)
- The `Global.Path.data` import and `fs.makeDirectory` call for the central directory are not needed

**Symptom:** New worktrees appear in `~/.local/share/opencode/worktree/` instead of next to the source project directory.

**Quick verification after merge:**
```bash
# makeWorktreeInfo should use dirname/basename of ctx.worktree, NOT Global.Path.data
grep -n "Global.Path.data" packages/opencode/src/worktree/index.ts
# Should return nothing — if it matches, the regression is back
grep -n "dirname\|basename" packages/opencode/src/worktree/index.ts
# Should see pathSvc.dirname(ctx.worktree) and pathSvc.basename(ctx.worktree)
```

### Worktree branch created with `opencode/` prefix

Upstream creates the git branch for new worktrees as `opencode/<name>` (e.g. `opencode/my-feature`). Dispatch removes this prefix so branches are created as plain `<name>` (e.g. `my-feature`). During merges the `candidate()` function in `worktree/index.ts` can revert to including the prefix.

**Design:**
- `branch = name` (not `` `opencode/${name}` ``)

**Quick verification after merge:**
```bash
grep -n "opencode/" packages/opencode/src/worktree/index.ts
# Should return nothing from the candidate() function — only the service tag string "@opencode/Worktree"
```

### @file autocomplete resolves paths against TUI launch directory instead of session directory

`createFilePart` and `normalizeMentionPath` in `prompt/autocomplete.tsx` fall back to `sync.path.directory` (the TUI's launch directory) when `props.directory` is not set. For worktree agent sessions the session's directory differs from the launch directory, so `@filename` suggestions are built against the wrong root and toasts like "cannot find file in ~/Documents" appear.

**Fix (two parts):**

1. In `autocomplete.tsx`, prefer `props.directory` over `sync.path.directory` in both helpers:
   ```ts
   // createFilePart
   const baseDir = (props.directory || sync.path.directory || process.cwd()).replace(/\/+$/, "")
   // normalizeMentionPath
   const baseDir = props.directory || sync.path.directory || process.cwd()
   ```

2. In `routes/session/index.tsx`, pass the session's stored directory to `<Prompt>`:
   ```tsx
   directory={sync.session.get(route.sessionID)?.directory}
   ```

**Symptom:** `@UPSTREAM-SYNC.md` toast error "cannot find file in ~/Documents" when session is running in a different directory than where the TUI was launched.

**Quick verification after merge:**
```bash
grep -n "props.directory" packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx
# Should appear in both createFilePart and normalizeMentionPath
grep -n "directory=" packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
# Should see directory={sync.session.get(route.sessionID)?.directory} on the <Prompt>
```

### MCP state is global, not per-directory (InstanceState removed)

Upstream uses `InstanceState.make<State>()` in `mcp/mcp.ts` to scope MCP connections per-directory. Dispatch replaces this with a plain closure-scoped `State` object inside `Layer.effect` — making MCP connections global across all agent sessions.

**Why:** The Claude Agent SDK invokes MCP tool callbacks asynchronously without preserving the AsyncLocalStorage Instance context. With per-directory state, `svc.clients()` / `svc.status()` return empty results when the ALS context is lost, causing "MCP server not connected" errors mid-session. Global state eliminates this class of bugs entirely.

**What changed:**
- `InstanceState.make<State>(...)` → plain `const s: State = {...}` in the Layer closure
- All `yield* InstanceState.get(state)` → removed (methods access `s` directly via closure)
- `Instance.directory` in `connectLocal` → captured once at init as `initCwd`
- `EffectBridge.make()` in `storeClient` → reuses `initBridge` captured at init

**If upstream merges reintroduce `InstanceState` for MCP:**
```bash
grep -n "InstanceState" packages/opencode/src/mcp/mcp.ts
# Should return only the comment explaining why it was removed — no actual usage
```

### MCP client.onerror handler removed or not set (transport errors silently kill connections)

Dispatch adds `client.onerror` in `setupReconnect()` (`mcp/mcp.ts`) that explicitly calls `client.close()` when a transport error occurs. This is critical because the MCP SDK's error path (`_onerror`) only calls `client.onerror` — it does **NOT** trigger `_onclose`. Without this handler, SSE timeouts, HTTP errors, and pipe failures fire `onerror` but the client remains in `"connected"` status with a dead stream. Tool calls silently fail and the agent sees "MCP disconnected / needs re-authentication."

**Design:**
- `setupReconnect()` sets `client.onerror = (error) => { log.error(...); client.close().catch(() => {}) }`
- `client.close()` triggers `transport.onclose` → `client._onclose()` → `client.onclose` → reconnect logic
- The reconnect logic in `client.onclose` handles exponential backoff (5s, 10s, 30s, 60s, 60s)

**Symptom:** Remote MCP servers (Linear, Notion, Slack) disconnect silently. The agent says "MCP needs re-authentication" even though OAuth tokens are still valid. Logs show repeated `mcp remote transport error` with `SSE error: The operation timed out` but no `mcp connection closed unexpectedly` message.

**Quick verification after merge:**
```bash
# setupReconnect should set client.onerror that calls client.close()
grep -n "client.onerror" packages/opencode/src/mcp/mcp.ts
# Should see: client.onerror = (error) => { ... client.close() ... }
```

### MCP proxy servers must NOT be shared between SDK sessions

`claude-sdk-query.ts` caches MCP tool **definitions** (not proxy server objects). Each `resolveMcpServers()` call creates fresh `createSdkMcpServer()` instances from the cached defs. MCP is point-to-point — if two SDK sessions share the same proxy server object, the second session's connection disconnects the first, causing "tool no longer available" errors.

**Symptom:** Agent A uses a groundcover tool successfully. Agent B starts and calls `resolveMcpServers()`. Agent A then loses access to the groundcover tool ("the mcp__groundcover-prod__query_metrics tool doesn't appear in the deferred tools list anymore").

**Quick verification after merge:**
```bash
# resolveMcpServers should always create fresh proxies, never return cached McpServerConfig objects
grep -A5 "cachedDefs\|createProxy" packages/opencode/src/session/claude-sdk-query.ts
```

### MCP tool definitions must NOT be cleared on cache invalidation (reconnect fallback)

`invalidateMcpCache()` in `claude-sdk-query.ts` must only set `dirty = true` — it must **not** clear `cachedDefs`. When an MCP server disconnects, the stale closed client remains in `s.clients` (it is only replaced on reconnect, never deleted on close). If `ToolsChanged` fires during the reconnect backoff window, `resolveDefs()` calls `listTools()` on the stale client, which fails. Without the previous `cachedDefs` as a fallback, that server is excluded from the rebuilt tool set and the next agent session has no tools for it.

**Two related invariants that must both survive merges:**

1. `invalidateMcpCache()` — only `dirty = true`, never `cachedDefs = undefined`
2. `resolveDefs()` — when `listTools()` returns nothing for a server, carry over `cachedDefs?.[name]` as a fallback so tools stay visible during the backoff window
3. `callTool` proxy handler — must check `svc.status()` before `svc.clients()`. Stale closed clients are never removed from the clients map, so without the status check you hit the dead transport and get an opaque error instead of a clear "MCP server X is not connected" message.

**Symptom:** After an MCP server briefly disconnects and reconnects, the next agent session is missing tools for that server. Or: tool calls fail with an opaque transport error rather than a clear "not connected" message.

**Quick verification after merge:**
```bash
# invalidateMcpCache should NOT clear cachedDefs
grep -A5 "invalidateMcpCache" packages/opencode/src/session/claude-sdk-query.ts
# Should only see: dirty = true (no cachedDefs = undefined)

# callTool handler should check status before clients
grep -A10 "CallToolRequestSchema" packages/opencode/src/session/claude-sdk-query.ts
# Should see: svc.status() check returning undefined if not "connected"
```

### MCP connections shared globally across agent sessions (not per-directory)

Dispatch shares a single pool of MCP connections across all agent sessions (including worktree agents). The `resolveMcpServers()` function in `claude-sdk-query.ts` resolves MCP clients via `AppRuntime.runPromise(MCP.Service.use((svc) => svc.clients()))` and caches them at module level. All Claude SDK sessions receive the same set of proxy MCP servers regardless of which directory they run in.

Upstream likely resolves MCP per-instance since MCP state uses `InstanceState.make()`. If upstream changes MCP resolution to be instance-scoped, worktree agents in Dispatch would lose access to the parent's MCP connections.

**What to watch for:**
- Changes to `resolveMcpServers()` that scope MCP clients to a specific directory
- Changes to `MCP.Service` that remove the global singleton nature (e.g., replacing `AppRuntime.runPromise` with instance-scoped resolution)
- The `ToolsChanged` bus event invalidation in `claude-sdk-query.ts` (lines ~133-136) must fire globally

**Quick verification after merge:**
```bash
# resolveMcpServers should use AppRuntime.runPromise (global), not instance-scoped
grep -n "AppRuntime.runPromise\|MCP.Service.use" packages/opencode/src/session/claude-sdk-query.ts
# healthCheck endpoint should exist
grep -n "health" packages/opencode/src/server/instance/mcp.ts
```

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
