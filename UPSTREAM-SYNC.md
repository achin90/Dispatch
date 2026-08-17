# Upstream Sync Workflow

Dispatch is a fork of [opencode](https://github.com/anomalyco/opencode). This document describes how to keep Dispatch in sync with upstream changes.

## Setup

**Remotes:**
- `origin` — `https://github.com/achin90/Dispatch.git` (Dispatch fork)
- `upstream` — `https://github.com/anomalyco/opencode.git` (upstream opencode)

**Primary branch:** `claudesdk` — all Dispatch development happens here.

**Strategy:** Merge-based workflow with `git rerere` for automatic conflict resolution.

**Configure these before you start — they are not defaults, and getting them wrong silently corrupts the merge:**

```bash
# git degrades moved files to delete+add once the rename detection budget is
# exhausted. Upstream moves whole directories (the entire TUI moved from
# packages/opencode/src/cli/cmd/tui to packages/tui), so with the default
# limit (~1000) the merge looks like "upstream deleted all our work".
git config merge.renameLimit 999999
git config diff.renameLimit 999999

# rerere was documented as enabled here for a long time while actually being off.
# Verify it, don't assume it.
git config rerere.enabled true
git config --get rerere.enabled   # must print: true
```

## Syncing Upstream

**Sync in hops, not one giant merge.** A single `git merge upstream/dev` across thousands of commits produces a conflict set nobody can reason about, and rerere learns nothing reusable. Instead pick checkpoint commits on `upstream/dev` — specifically ones *just before* a large deletion or relocation (e.g. the commit before the Hono backend was deleted, the commit before the TUI moved to `packages/tui`) — merge to that checkpoint, port Dispatch's code forward onto the new structure, commit, and only then merge past the deletion.

```bash
git fetch upstream
git log --oneline claudesdk..upstream/dev        # find checkpoints
git merge <checkpoint-sha>                        # one hop
# ... resolve, port forward, typecheck, commit ...
git merge upstream/dev                            # final hop
```

The last sync was 4 hops over ~3,461 upstream commits; see `git log --oneline --grep "Merge upstream hop"`.

`rerere` auto-resolves conflicts it has seen before. Only genuinely new conflicts require manual resolution.

## Resolving Conflicts

1. **Understand both sides.** For each conflicted file, check what upstream changed vs what Dispatch changed. Use `git log upstream/dev --oneline -- <file>` and `git log --oneline -- <file>`.

2. **Keep Dispatch features.** Bring in upstream architectural/system upgrades while preserving ALL Dispatch features.

3. **Watch for overlapping implementations.** If upstream now implements something Dispatch added custom code for, migrate Dispatch to use upstream's version instead of maintaining a parallel implementation.

4. **Distinguish "deleted" from "moved".** Before concluding upstream deleted something, search for the symbol across the whole tree: `rg -n "<symbol>" packages/`.

5. **Run typecheck after resolving.** From `packages/opencode`: `bun typecheck`

6. **Commit the merge.** `rerere` will record your resolutions for next time.

## Repository Layout (post-merge)

The paths in this document reflect the current tree. Three moves invalidated most older notes:

| Old | New |
|-----|-----|
| `packages/opencode/src/cli/cmd/tui/` | `packages/tui/src/` (standalone workspace package) |
| `packages/opencode/src/permission/permission.ts` | `packages/opencode/src/permission/index.ts` |
| `packages/opencode/src/mcp/mcp.ts` | `packages/opencode/src/mcp/index.ts` |
| `packages/opencode/src/server/instance/session.ts` (Hono) | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (Effect HttpApi) |
| `packages/opencode/src/server/instance/mcp.ts` (Hono) | `.../httpapi/handlers/mcp.ts` |
| `packages/opencode/test/cli/tui/*` | `packages/tui/test/cli/tui/*` |

**The Hono backend is gone.** Every route is now an Effect `HttpApi` endpoint declared in `server/routes/instance/httpapi/groups/<name>.ts` and implemented in `.../handlers/<name>.ts`. There is no `app.get(...)` / `c.json(...)` anywhere.

## Known Dispatch-Specific Features to Preserve

These features exist only in Dispatch and must survive every upstream merge.

**Claude Agent SDK**
- Core — `session/claude-sdk-query.ts`, `claude-sdk-processor.ts`, `claude-sdk-adapter.ts`, `claude-sdk-session-map.ts`, `claude-sdk-permissions.ts`
- `session/claude-sdk-bin.ts` — resolves the bundled `claude` CLI binary the SDK spawns
- `session/compaction.ts` — the Claude SDK compaction path (`PostCompact` hook feeds `compactRef.summary` back into the session)
- ExitPlanMode agent switch — `claude-sdk-permissions.ts` (~line 592) intercepts the SDK's `ExitPlanMode` tool and asks the user which agent to switch to
- Background subagents disabled — `claude-sdk-permissions.ts` (~line 264) forces `run_in_background: false` on the SDK's `Agent`/`Task` tools. A backgrounded task would outlive the turn that owns it, so its output is never collected.

**Server / session**
- Session-instance redirection — `withSessionInstance` in `server/routes/instance/httpapi/handlers/session.ts` (see pitfall below)
- 8 Dispatch experimental HttpApi routes — `gitRepos`, `githubStatus`, `githubPr`, `githubPrCreate`, `githubPrMerge`, `worktreeInfo`, `worktreeDiff`, `worktreeDiffstat` in `httpapi/groups/experimental.ts` + `handlers/experimental.ts`
- Haiku response summaries — `session/summarize.ts` (pinned to `claude-haiku-4-5-20251001`) + the `lastResponse` handler in `handlers/session.ts`
- Cross-directory event bridge — `bus/global.ts` and `packages/tui/src/context/event.ts` (must accept events from all directories)
- Permission merging + global pending map — `permission/index.ts` (`merge()`, `globalPending`)
- Question global pending map — `question/index.ts` (module-level `index`)
- Static SDK model definitions — `provider/provider.ts` (`SDK_MODELS`, `buildSdkModel`)
- Activity display — `formatActivity()` in `session/processor.ts`; the `activity` field now lives upstream-adjacent in `packages/schema/src/session-status-event.ts`
- Worktree support — `worktree/index.ts` (sibling-path creation, no `opencode/` branch prefix)
- **Not** a must-preserve: the `# Worktree Agent Context` block in `session/system.ts` (~line 129, inside `SystemPrompt.environment`). It never reaches the Claude SDK path — `session/prompt.ts` (~line 1296) builds the SDK system prompt from `agent.prompt` + `sys.skills` + instructions only, with `// ...env,` deliberately commented out. The `/merge` command covers the same ground. Only the AI SDK path (~line 1524) calls `sys.environment`. Do not spend merge effort defending it.
- Yolo agent — `agent/agent.ts` (auto-approve permissions)
- Subagent permission seeding — `tool/task.ts` (see pitfall below)
- Custom commands — `/deepReview` and `/merge` in `command/index.ts`
- MCP connection sharing + reconnect — `mcp/index.ts` (`client.onerror` closes to trigger reconnect), `claude-sdk-query.ts` (global MCP def cache), `handlers/mcp.ts` (`health` endpoint)

**TUI (`packages/tui/src/`)**
- Agent dashboard / multi-agent — `routes/home.tsx` (agent list, worktree creation, PR integration, diff stats, `/merge`)
- Dashboard inline prompt overlay — `i` keybind in `routes/home.tsx` (~line 836) opens a prompt for the selected agent without leaving the dashboard
- PTY terminal attach — `util/pty.ts` (`PtyAttach`), `t` keybind in `routes/home.tsx` (~line 835); drops into a live shell in the agent's worktree
- Diffview route — `routes/diffview.tsx`, reached via the `diff()` navigator in `routes/home.tsx` (~line 629), bound to `D` (shift+d) in the key handler (~line 832), and rendered from `app.tsx`
- `worktree.ready` event → diffstat refetch — `routes/home.tsx` (~line 357); without it a freshly created worktree shows a stale/empty diffstat forever
- Repo/directory pickers — `component/dialog-git-repo-select.tsx` and `component/dialog-directory-select.tsx`, backed by `/experimental/git-repos`
- Agent summaries — `component/agent-summaries.tsx` + the `agent_summary` slot in `context/sync.tsx`
- Permission reject always collects a reason — `routes/session/permission.tsx` (~line 424); the `reject` option routes to a `reject` stage instead of replying immediately, so the feedback reaches the model
- Queued message handling — `component/prompt/index.tsx` and `session/prompt.ts` (cancel + restore)
- Draft restore — `routes/session/index.tsx` (`bind` / `boundSessionID` / `drafts`)

## Known Pitfalls

### Event filtering drops agent session updates
Upstream's `useEvent()` hook in `packages/tui/src/context/event.ts` filters events by directory/workspace. Agent sessions running in worktree directories publish events under their worktree path, not the main project directory. The filter must accept events from all directories or agent session updates will be invisible to the TUI. The originating directory/workspace is passed through to the handler as a second argument instead.

**Quick verification after merge:**
```bash
rg -n "No directory/workspace filtering here on purpose" packages/tui/src/context/event.ts
# Must match — the comment sits on the code that deliberately does not filter
```

### AsyncLocalStorage context is load-bearing for the Claude SDK path

**This is the single most dangerous class of regression in the fork.** It has caused two separate total outages of the Claude SDK path, each presenting as a *silently dead prompt with no error at all*. Nothing in the test suite caught either one.

**Design:** Effect carries the instance on the *fiber*. The Claude Agent SDK invokes Dispatch callbacks (`canUseTool`, MCP tool handlers, stream processing) from plain async code where no Effect fiber exists — `Fiber.getCurrent()` is `undefined` there. The only context that survives that boundary is AsyncLocalStorage. Two pieces make this work and both must survive merges:

1. **`session/prompt.ts` (~lines 1345, 1376)** wraps `createClaudeSdkQuery(...)` and `processClaudeSdkStream(...)` in `Instance.restore(ctx, () => ...)`. `restore` *reconstructs* ALS from the Effect-side `InstanceContext` — it does not inherit it, because there is nothing to inherit from.
2. **`effect/run-service.ts` `attach()`** must prefer the ALS instance (`Instance.current`) over `Fiber.getCurrent()`. Upstream's version reads the fiber only. With the fiber-only version every `AppRuntime.runPromise` from an SDK callback dies with "InstanceRef not provided" — and because those callbacks are fire-and-forget, real prompts just hang indefinitely with no error.

**Corollary:** `InstanceState.directory` **defects** when there is no ALS context. Any code reachable from a non-HTTP entrypoint (layer construction, CLI, SDK callbacks) must use a safe fallback instead — see `currentDirectory` in `mcp/index.ts` (~line 143), which reads `(yield* InstanceRef)?.directory ?? process.cwd()`.

**Symptom:** Prompt submits, spinner never appears or never clears, no log line, no error, no toast. Works fine on the AI SDK path.

**Quick verification after merge:**
```bash
rg -n "Instance.restore" packages/opencode/src/session/prompt.ts
# Must show 2 matches (createClaudeSdkQuery + processClaudeSdkStream)

rg -n "Dispatch: prefer the AsyncLocalStorage instance context" packages/opencode/src/effect/run-service.ts
# Must match — if gone, upstream's fiber-only attach() is back

rg -n "InstanceState.directory would defect" packages/opencode/src/mcp/index.ts
# Must match — guards the currentDirectory helper
```

### Agent session directory context lost on merge

Upstream's session handler calls `SessionPrompt` methods directly against the *requester's* instance — there is no concept of per-session directory context. Dispatch defines `withSessionInstance(sessionID, effect)` at the top of `server/routes/instance/httpapi/handlers/session.ts` (~line 76), which looks up the session's owning instance and runs the effect with `Effect.provideService(InstanceRef, instance)`. Without it, tools, system prompts, and file operations resolve against the TUI's startup directory instead of the agent's worktree.

There is also `withSessionInstanceOptional` (~line 84): identical, except an unknown session falls through to the requester's instance rather than failing. Only `abort` uses it — aborting a session the server has never heard of must not 404.

**Nine handlers are directory-aware:**

| Handler | Mechanism |
|---------|-----------|
| `abort` | `withSessionInstanceOptional` |
| `init`, `summarize`, `prompt`, `promptAsync`, `command`, `shell`, `deleteMessage` | `withSessionInstance` |
| `lastResponse` | `sessionInstance()` + `WithInstance.provide({ directory })` (it needs the raw directory for provider resolution, not an `InstanceRef`) |

**`prompt` is the one that bites.** It must take its `InstanceRef` from the *session's* instance. Taking it from `InstanceState.context` (the requester's) silently executes worktree agent prompts against the TUI's directory — no error, wrong files.

**What to watch for during merges:**
- Any new or modified handler in `handlers/session.ts` that calls `promptSvc.*` must be wrapped.
- Upstream may refactor how `SessionPrompt` is invoked. Regardless of the calling convention, the wrapper must remain.
- New session routes that do work scoped to a session's directory need the wrapper too.

**Quick verification after merge:**
```bash
H=packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts
rg -n "withSessionInstance" $H
# Must show the two definitions (~76, ~84), the comment on ~81, plus 8 call sites
test "$(rg -c 'withSessionInstance\(|withSessionInstanceOptional\(' $H)" = 8 && echo OK || echo REGRESSION

rg -n "the prompt must run in the instance that owns the session" $H
# Must match — the comment sits on the prompt handler's wrapper
```

### SessionStatus endpoint misses worktree agent activity
The `status` handler in `handlers/session.ts` (~line 104) calls `statusSvc.list()` without any session-instance wrapper — it cannot, because it is not scoped to a single session. Because `SessionStatus` uses `InstanceState.make()` (keyed by Instance directory), agent sessions running in worktrees store their status under the worktree's Instance, but the endpoint reads from the TUI's startup directory Instance. Real-time events work (GlobalBus broadcasts everywhere), but the initial bootstrap fetch at TUI startup returns empty status for worktree agents.

**Symptom:** Agent activity ("Thinking...", "Bash pwd", etc.) shows up momentarily but disappears on reload or is missing on initial load.

### `activity` field on session status lives in the schema package
Dispatch's optional `activity` string on the busy status variant is defined in `packages/schema/src/session-status-event.ts`, not in a local type in `session/status.ts`. `session/status.ts` re-exports `SessionStatusEvent.Info`. Merges that regenerate or replace the schema package can drop the field, which makes `formatActivity()` output vanish with no type error on the producer side.

**Quick verification after merge:**
```bash
rg -n "activity" packages/schema/src/session-status-event.ts
# Must show: activity: optional(Schema.String)
rg -n "activity" packages/opencode/src/session/status.ts
# Must show the comment pointing at @opencode-ai/schema/session-status-event
```

### Claude SDK token counting regresses to per-stream accumulation
Upstream's AI SDK path accumulates tokens from `finish-step` stream events in `session/processor.ts`. The Claude SDK path must NOT do this — it sets tokens once from the `SDKResultMessage.usage.*` totals in `processResultMessage()` in `claude-sdk-processor.ts`. If someone applies the AI SDK's per-event token pattern to the SDK processor, token counts become wrong (double-counted or missing cache tokens).

**What to watch for:** Any code that sets `assistantMessage.tokens` in the Claude SDK stream loop (before the result message) is a regression. Guarded by `test/claude-sdk/token-counting.test.ts`.

### `@opencode-ai/core/util/log` was deleted upstream
Upstream removed the shared logger module. Dispatch's async Claude SDK call sites cannot use the Effect logger (no fiber — see the ALS pitfall), so they log through `packages/opencode/src/util/log-bridge.ts` (`create({ service })`). `packages/tui` logs via plain `console.*`.

**Current consumers of `log-bridge`:** `session/claude-sdk-permissions.ts`, `session/claude-sdk-processor.ts`, `session/claude-sdk-query.ts`, `session/compaction.ts`, `github/index.ts`.

**Quick verification after merge:**
```bash
ls packages/opencode/src/util/log-bridge.ts        # must exist
rg -ln "log-bridge" packages/opencode/src          # must list the 5 consumers above
rg -n 'from "@opencode-ai/core/util/log"' packages/opencode/src packages/tui/src
# Must return nothing — that module no longer exists.
# (A plain `rg "core/util/log"` also matches the explanatory comment in log-bridge.ts.)
```

### Custom commands (/deepReview, /merge) removed during merge
Upstream only defines `/init` and `/review` in `command/index.ts`. Dispatch adds `/deepReview` and `/merge`, defined in `Command.Default` with template imports `PROMPT_DEEP_REVIEW` (`command/template/deep-review.txt`) and `PROMPT_MERGE` (`command/template/merge.txt`). During merges the definitions and their template imports can be lost.

**Quick verification after merge:**
```bash
rg -n "PROMPT_MERGE|PROMPT_DEEP_REVIEW" packages/opencode/src/command/index.ts
# Must show both imports and both usages (4+ lines)
```

### Keybind guards — now satisfied natively by the keymap engine

**The old `guards.ts` is gone.** It is dead code and has been deleted along with its test. Do not re-add it, and do not "restore" it if a merge resurrects the file.

Upstream replaced the imperative keybind engine (`useKeybind`, `keybind.match`, `keybind.print`, `keybind.leader`) with a declarative one from `@opentui/keymap`. Bindings are registered as:

```tsx
useBindings(() => ({
  enabled: ...,
  mode: OPENCODE_BASE_MODE,
  commands: [{ name: "app.exit", title: "...", category: "...", run() { ... } }],
  bindings: [{ key: "escape", desc: "...", group: "...", cmd: () => ... }, ...tuiConfig.keybinds.get("app.exit")],
}))
```

Both guards Dispatch used to implement by hand are now enforced by the engine:

1. **Dialog guard** (don't let escape reach the permission/question prompt while a dialog is open) — `packages/tui/src/ui/dialog.tsx` (~line 83) pushes mode `"modal"` onto the mode stack whenever `store.stack.length > 0` and pops it on cleanup. Bindings registered with `mode: OPENCODE_BASE_MODE` simply do not fire while `"modal"` is on top.
2. **Leader guard** (don't let escape reject a permission while a leader sequence is pending) — `registerEscapeClearsPendingSequence(keymap)` in `packages/tui/src/keymap.tsx` (~line 227) consumes escape to clear the pending sequence before any command sees it.

**Old → new API mapping** (a future syncer will hit this):

| Old | New |
|-----|-----|
| `keybind.print(x)` | `useCommandShortcut(commandId)()` — `keymap.tsx` (~line 250) |
| `keybind.match("app_exit", evt)` | register a command `{ name: "app.exit", run() {} }` in `useBindings` |
| `keybind.leader` | `useLeaderActive()` — `keymap.tsx` (~line 246) |

**What to re-check if upstream changes this:** if `ui/dialog.tsx` stops pushing `"modal"`, or `registerEscapeClearsPendingSequence` stops being registered, the guards silently disappear and escape starts dismissing the wrong prompt again.

**Quick verification after merge:**
```bash
rg -n 'modeStack.push\("modal"\)' packages/tui/src/ui/dialog.tsx
rg -n "registerEscapeClearsPendingSequence" packages/tui/src/keymap.tsx
# Both must match

rg -n "useKeybind|keybind\.match|keybind\.print|keybind\.leader" packages/tui/src packages/opencode/src
# Must return nothing — the old API is gone

ls packages/tui/src/guards.ts 2>/dev/null && echo "REGRESSION: guards.ts is back"
```

### Draft save/restore logic lost or broken
Dispatch saves the prompt draft when permission dialogs appear (Prompt unmounts) and restores it when they dismiss (Prompt remounts). The logic uses `shouldSave()`, `resolve()`, and `shouldBlock()` from `packages/tui/src/draft.ts`. Upstream has no draft persistence across permission dialogs. The auto-submit prevention (`shouldBlock`) is critical — without it, the Enter key that navigated into the session auto-submits the restored draft.

**Single restore path via `bind` in `routes/session/index.tsx`:**

Draft persistence is handled entirely by the session route's `bind` callback (~line 354) and its module-level `drafts` Map. The Prompt component itself has NO draft stash logic — upstream's module-level `stashed` variable has been removed.

- When Prompt unmounts (permission dialog, or navigating home), `bind(undefined)` saves the current prompt using `boundSessionID`.
- When Prompt remounts, `bind(r)` calls `resolveDraft(...)` → `r.set(draft, true)` → sets `restored = true` in the Prompt closure, preventing auto-submit.

**Why Prompt has no stash:** upstream's module-level `let stashed` is a single global slot shared by all Prompt instances, and `props.sessionID` is a reactive SolidJS getter that may already reflect the new route by the time `onCleanup` fires. Drafts leak between sessions. The session route's `bind`/`drafts` mechanism is per-session and doesn't have this problem.

**Critical: use `boundSessionID`, not `route.sessionID`, when saving drafts on unmount.** `route.sessionID` is reactive; by the time `bind(undefined)` fires during cleanup it already returns `null`, and drafts saved under `null` are never found on re-entry. `boundSessionID` is captured at mount time (~line 368) and reused at unmount (~line 359) and in the dashboard keybind handler (`boundSessionID ?? route.sessionID`, ~line 413).

**If upstream re-adds a `stashed` variable to `component/prompt/index.tsx`, remove it.**

**Symptom if broken:** typed text disappears when a permission dialog appears; or the restored draft auto-submits without confirmation; or draft text from one agent session appears in another; or the draft is never restored on re-entry.

**Quick verification after merge:**
```bash
rg -n "stashed" packages/tui/src/component/prompt/index.tsx && echo "REGRESSION: stash is back"
# Must return nothing

rg -n "boundSessionID" packages/tui/src/routes/session/index.tsx
# Must show the declaration plus uses in bind() (save + capture) and the dashboard handler
```

### Permission pending map scoped to InstanceState instead of global
Upstream stores the pending permission map inside `InstanceState`, keyed by Instance directory. Dispatch needs a **module-level** `globalPending` map so the TUI (running in the main project directory) can reply to permission requests raised by agent sessions in worktree directories. Without this, pressing y/n on a permission dialog from the dashboard does nothing.

**Design:**
- `globalPending` (module-level `Map<PermissionV1.ID, PendingEntry>`, `permission/index.ts` ~line 32) holds ALL pending entries across all directories.
- Each `PendingEntry` captures the `approved` ruleset from the agent's InstanceState at `ask()` time, so `reply()` doesn't need to resolve its own InstanceState.
- Each instance tracks which entries it owns (`ownedPending`), so the dispose finalizer only rejects its own.
- `list()` and `reply()` read from `globalPending` directly.

**Symptom:** pressing y/n from the dashboard does nothing; the dialog stays visible indefinitely.

**Quick verification after merge:**
```bash
rg -n "globalPending" packages/opencode/src/permission/index.ts
# Must show `const globalPending = new Map<...>()` at module level plus uses in ask/reply/list
```

### Question pending map scoped to InstanceState instead of global
Same issue as permissions, in `question/index.ts`. `ask()` runs in the agent's directory context (via `Instance.bind` in `claude-sdk-permissions.ts`); `reply()` runs in the TUI's. Different `ScopedCache` entries, so `reply()` can never find the request. Affects **both single- and multi-question prompts**.

**Design:**
- `index` (module-level `Map<QuestionID, PendingEntry>`, ~line 46) holds ALL pending entries.
- Each instance still has its own `pending` map in `InstanceState` for finalizer cleanup.
- `ask()` stores in both; `Effect.ensuring` cleanup deletes from both.
- `reply()`, `reject()`, `list()` read from `index` directly.

**Symptom:** the question dialog appears but Enter/Escape do nothing. The HTTP reply returns 200 and the Question service logs `"reply for unknown request"`.

**Quick verification after merge:**
```bash
rg -n "^const index = new Map" packages/opencode/src/question/index.ts
# Must match — module level, not inside InstanceState init
```

### Worktree path created in central data directory instead of as sibling
Upstream creates new worktrees under `~/.local/share/opencode/worktree/<projectId>/<slug>`. Dispatch creates them as siblings of the parent worktree (`/projects/BillingService` → `/projects/BillingService-feature-name`). During merges `makeWorktreeInfo` in `worktree/index.ts` can revert to `Global.Path.data`.

**Design:**
- `root` = `pathSvc.dirname(ctx.worktree)`
- `base` = `<pathSvc.basename(ctx.worktree)>-<slugifiedName>` (or just the basename when no name is given, which triggers the collision-avoidance loop)
- No `Global.Path.data` import, no `fs.makeDirectory` for a central directory

**Symptom:** new worktrees appear in `~/.local/share/opencode/worktree/` instead of next to the source project.

**Quick verification after merge:**
```bash
rg -n "pathSvc.dirname\(ctx.worktree\)" packages/opencode/src/worktree/index.ts
# Must match (~line 214) — this is the load-bearing line

rg -n "Global\.Path\.data" packages/opencode/src/worktree/index.ts
# Must match ONLY the explanatory comment ("not under Global.Path.data."), never real code
```

### Worktree branch created with `opencode/` prefix
Upstream creates the branch as `opencode/<name>`. Dispatch drops the prefix. The invariant now also has to account for detached worktrees, which have no branch at all:

**Design:** in `candidate()` (`worktree/index.ts` ~line 184):
```ts
const branch = input.detached ? undefined : name
```

**Quick verification after merge:**
```bash
rg -n 'const branch = input.detached \? undefined : name' packages/opencode/src/worktree/index.ts
# Must match. If it doesn't, either the prefix is back or the detached case was lost.
```

### @file autocomplete resolves paths against TUI launch directory instead of session directory

The dashboard renders a `<Prompt>` for agent sessions that live in worktree directories, outside of any session `LocationProvider`. `packages/tui/src/component/prompt/autocomplete.tsx` must therefore prefer an explicitly supplied `props.directory` over the ambient location.

**Fix (two parts):**

1. In `autocomplete.tsx` (~line 105), a `resolvedLocation` memo:
   ```ts
   const resolvedLocation = createMemo(() =>
     props.directory ? { directory: props.directory, workspaceID: location()?.workspaceID } : location(),
   )
   ```
   `createFilePart` and `normalizeMentionPath` both resolve their base directory through `resolvedLocation()` (falling back to `sync.path.directory`, then `paths.cwd`).

2. In `routes/session/index.tsx`, pass the session's stored directory to `<Prompt>`:
   ```tsx
   directory={sync.session.get(route.sessionID)?.directory}
   ```
   (also done for the permission and question prompts, using the request's `sessionID`).

**Symptom:** `@UPSTREAM-SYNC.md` toast error "cannot find file in ~/Documents" when the session runs in a different directory than where the TUI was launched.

**Quick verification after merge:**
```bash
rg -n "resolvedLocation" packages/tui/src/component/prompt/autocomplete.tsx
# Must show the memo plus its use in normalizeMentionPath and the suggestion query

rg -n "directory=\{sync\.session" packages/tui/src/routes/session/index.tsx
# Must show 3 matches: permission prompt, question prompt, and the main <Prompt>
```

### MCP state is global, not per-directory (InstanceState removed)

Upstream uses `InstanceState.make<State>()` in `mcp/index.ts` to scope MCP connections per-directory. Dispatch replaces this with a plain closure-scoped `State` object inside `Layer.effect` — making MCP connections global across all agent sessions.

**Why:** the Claude Agent SDK invokes MCP tool callbacks asynchronously; with per-directory state, `svc.clients()` / `svc.status()` return empty results whenever the ALS context is lost, causing "MCP server not connected" mid-session. Global state eliminates the class of bug.

**What changed:**
- `InstanceState.make<State>(...)` → plain `const s: State = {...}` in the Layer closure
- All `yield* InstanceState.get(state)` → removed (methods access `s` via closure)
- `Instance.directory` in `connectLocal` → the lazy `currentDirectory` helper (~line 143). **The old `initCwd` eager capture is gone** — it was captured at layer-build time, where there is no ALS context.

**Quick verification after merge:**
```bash
rg -n "InstanceState" packages/opencode/src/mcp/index.ts
# Must match ONLY the two explanatory comments (~142, ~592) — no real usage

rg -n "initCwd" packages/opencode/src/mcp/index.ts
# Must return nothing — replaced by currentDirectory
```

### MCP client.onerror handler removed or not set (transport errors silently kill connections)

Dispatch sets `client.onerror` in `setupReconnect()` (`mcp/index.ts` ~line 515) to explicitly call `client.close()`. The MCP SDK's error path (`_onerror`) only calls `client.onerror` — it does **NOT** trigger `_onclose`. Without this handler, SSE timeouts, HTTP errors, and pipe failures fire `onerror` but the client stays in `"connected"` status with a dead stream.

**Design:**
- `client.onerror = (error) => { log.error(...); client.close().catch(() => {}) }`
- `client.close()` → `transport.onclose` → `client._onclose()` → `client.onclose` → reconnect
- `client.onclose` handles exponential backoff (5s, 10s, 30s, 60s, 60s)

**Symptom:** remote MCP servers (Linear, Notion, Slack) disconnect silently. The agent says "MCP needs re-authentication" though OAuth tokens are valid. Logs show repeated `mcp remote transport error` with `SSE error: The operation timed out` and no `mcp connection closed unexpectedly`.

**Quick verification after merge:**
```bash
rg -n -A4 "client.onerror = " packages/opencode/src/mcp/index.ts
# Must show the handler calling client.close()
```

### MCP proxy servers must NOT be shared between SDK sessions

`claude-sdk-query.ts` caches MCP tool **definitions** (not proxy server objects). Each `resolveMcpServers()` call creates fresh `createSdkMcpServer()` instances from the cached defs. MCP is point-to-point — if two SDK sessions share the same proxy server object, the second session's connection disconnects the first.

**Symptom:** Agent A uses a tool successfully. Agent B starts and calls `resolveMcpServers()`. Agent A then loses access to that tool.

**Quick verification after merge:**
```bash
rg -n "Cache tool DEFINITIONS" packages/opencode/src/session/claude-sdk-query.ts
# Must match (~line 74) — the comment sits on cachedDefs
```

### MCP tool definitions must NOT be cleared on cache invalidation (reconnect fallback)

Three invariants in `claude-sdk-query.ts` that must all survive:

1. `invalidateMcpCache()` — only sets `dirty = true`; must **never** do `cachedDefs = undefined`. When a server disconnects, the stale closed client remains in `s.clients` (replaced on reconnect, never deleted on close). If `ToolsChanged` fires during the backoff window, `listTools()` on the stale client fails, and without `cachedDefs` as a fallback that server vanishes from the next session's tool set.
2. `resolveDefs()` — when `listTools()` returns nothing for a server, carry over `cachedDefs?.[name]`.
3. The `callTool` proxy handler (~line 102) — must check `svc.status()` **before** `svc.clients()`. Stale closed clients are never removed from the map, so without the status check you hit the dead transport and get an opaque error instead of "MCP server X is not connected".

**Quick verification after merge:**
```bash
rg -n -A6 "function invalidateMcpCache" packages/opencode/src/session/claude-sdk-query.ts
# Must show `dirty = true` and the "Do NOT clear cachedDefs" comment — no cachedDefs = undefined

rg -n 'yield\* svc.status\(\)\)\[name\]\?\.status !== "connected"' packages/opencode/src/session/claude-sdk-query.ts
# Must match — the status check inside the callTool handler
```

### MCP connections shared globally across agent sessions (not per-directory)

`resolveMcpServers()` resolves MCP clients via `AppRuntime.runPromise(MCP.Service.use((svc) => svc.clients()))` and caches at module level. All Claude SDK sessions get the same proxy set regardless of directory. If upstream makes MCP resolution instance-scoped, worktree agents lose access to the parent's connections.

**What to watch for:**
- Changes to `resolveMcpServers()` that scope MCP clients to a directory
- Changes to `MCP.Service` that remove the global singleton nature
- The `ToolsChanged` bus event invalidation must fire globally

**Quick verification after merge:**
```bash
rg -n "MCP.Service.use" packages/opencode/src/session/claude-sdk-query.ts
# Must show AppRuntime.runPromise(MCP.Service.use(...)) — global, not instance-scoped

rg -n "healthCheck" packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts
# Must match — the /mcp/health handler
```

### Claude SDK post-turn queued-message check loops forever on stale user messages

The Claude SDK turn loop in `session/prompt.ts` had a post-turn check that scanned for queued user messages using `m.info.id > last.info.id`. Message IDs are not chronologically sortable — a stale user message (e.g. from a prior agent switch) can permanently sort after newer assistant messages and make every iteration `continue`, looping the same turn forever.

**Fix:** replaced the ID-based check with a user message count comparison. Store `msgs.filter(user).length` before the SDK turn; after the turn, reload messages and compare counts. If the count grew, a new message was queued — `continue`. Otherwise `break`. One integer, no ID ordering dependency.

**Symptom:** agent keeps running the same command repeatedly after a prompt, never stops.

**Quick verification after merge:**
```bash
rg -n "userCountBefore" packages/opencode/src/session/prompt.ts
# Should show the count snapshot before the SDK turn and the comparison after
```

### Subagent permission ordering — `evaluate()` uses `findLast()`, so LAST match wins

**Read this carefully; an earlier sync got it backwards by assuming first-match-wins.** `Permission.evaluate()` in `permission/index.ts` (~line 45) selects a rule with `.findLast(...)`. **The last matching rule in the array wins.**

`tool/task.ts` (~line 164) builds the child session's ruleset in this exact order, and the order is the whole point:

```ts
permission: [
  ...(caller?.permission ?? []),   // 1. calling agent's own ruleset as the BASELINE
  ...childPermission,              // 2. upstream's derived rules
  ...childToolDenies,              // 3. subagent todowrite/task denies
]
```

The calling agent's broad rules go **first** so they act as defaults — a yolo caller propagates its grants to subagents. Upstream's narrow derived rules (the parent session's `external_directory`/deny grants, and the subagent's `todowrite`/`task` denies) go **last** so they still win over the caller's broad defaults.

**Symptom if reordered:** move the caller's rules to the end and its broad `allow` overrides the `todowrite`/`task` denies, so subagents start spawning nested subagents. Drop the caller's rules entirely and subagents spawned by a yolo agent start prompting for every permission.

**Quick verification after merge:**
```bash
rg -n "findLast" packages/opencode/src/permission/index.ts
# Must match — if this becomes `.find(`, every ruleset in the fork inverts

rg -n "evaluate\(\) uses findLast, so LAST match wins" packages/opencode/src/tool/task.ts
# Must match — the comment sits directly above the ordered array
```

### Dispatch experimental HttpApi routes lose their `query` declaration

The 8 Dispatch routes in `httpapi/groups/experimental.ts` are `gitRepos`, `githubStatus`, `githubPr`, `githubPrCreate`, `githubPrMerge`, `worktreeInfo`, `worktreeDiff`, `worktreeDiffstat`.

They take their target directory three different ways, and mixing them up is how the port regressed:

| Route(s) | Directory input |
|----------|-----------------|
| `worktreeInfo`, `worktreeDiff`, `worktreeDiffstat` | **`query: WorkspaceRoutingQuery`** |
| `gitRepos` | `query: GitReposQuery` (`root`, `query`) |
| `githubPr` | `query: GitHubPrQuery` (`branch`, `cwd`) |
| `githubPrCreate`, `githubPrMerge` | `payload` with an explicit `cwd` field |
| `githubStatus` | none — it's a global `gh` CLI auth check |

**The three worktree routes must declare `query: WorkspaceRoutingQuery` on the endpoint.** This was a real regression during the Hono→HttpApi port: **without the `query` declaration the generated SDK client silently drops the `directory` parameter.** No type error, no runtime error — `sdk.client.worktree.diffstat({ directory })` in `routes/home.tsx` just resolves against the TUI's instance and every agent shows the wrong diffstat.

When adding a new Dispatch route that operates on a worktree, either spread `...WorkspaceRoutingQueryFields` into its query schema (as `ToolListQuery` and `SessionListQuery` do) or use `WorkspaceRoutingQuery` directly.

**Quick verification after merge:**
```bash
G=packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts
for r in gitRepos githubStatus githubPr githubPrCreate githubPrMerge worktreeInfo worktreeDiff worktreeDiffstat; do
  rg -q "HttpApiEndpoint\.(get|post)\(\"$r\"" $G || echo "MISSING ROUTE: $r"
done
# Must print nothing — all 8 routes present

for r in worktreeInfo worktreeDiff worktreeDiffstat; do
  rg -A2 "HttpApiEndpoint\.get\(\"$r\"" $G | rg -q "query: WorkspaceRoutingQuery" || echo "MISSING WorkspaceRoutingQuery: $r"
done
# Must print nothing

rg -n "WorkspaceRoutingQueryFields" $G
# Must match — the shared query fields other query schemas spread
```

### Upstream update check fires for Dispatch users

`cli/upgrade.ts` → `upgrade()` fetches from `https://api.github.com/repos/anomalyco/opencode/releases/latest` and shows an "Update Available" dialog. Dispatch is a fork — this must never run. The file has an unconditional early return.

**Quick verification after merge:**
```bash
rg -n "Dispatch is a fork" packages/opencode/src/cli/upgrade.ts
# Must match
```

### Effect framework migrations
Upstream is actively migrating to Effect's `Context.Service` pattern (from the older `ServiceMap.Service`). When merging, watch for:
- `ServiceMap` imports that need to become `Context`
- `InstanceState.withALS` calls that were removed (use direct service calls instead)
- Facade functions that were removed (upstream removes `runPromise` wrappers as they migrate to full Effect)
- `Layer.unwrap(Effect.sync(...))` → `Layer.suspend(() => ...)`
- Import cycles: the TUI runs its app runtime in a worker; a cycle through `app-runtime` kills it silently on boot (see commit `27dafbfec9`)

## Dispatch Regression Tests

These files guard Dispatch features against upstream merge regressions. All 18 exist in the current tree and pass as of the last merge: 290 tests in `packages/opencode`, 18 in `packages/tui`.

```bash
# From packages/opencode
bun test \
  test/session/format-activity.test.ts \
  test/permission/next.test.ts \
  test/permission/subagent-hook.test.ts \
  test/server/session-directory.test.ts \
  test/server/session-creation-directory.test.ts \
  test/server/event-cross-directory.test.ts \
  test/server/git-repos.test.ts \
  test/provider/sdk-models.test.ts \
  test/claude-sdk/adapter.test.ts \
  test/claude-sdk/error-extraction.test.ts \
  test/claude-sdk/token-counting.test.ts \
  test/claude-sdk/session-map.test.ts \
  test/claude-sdk/pending-meta.test.ts \
  test/claude-sdk/permission.test.ts \
  test/claude-sdk/message-map.test.ts \
  test/claude-sdk/session-loop.test.ts \
  test/command/dispatch-commands.test.ts \
  --timeout 30000

# From packages/tui (the TUI is its own workspace package now)
bun test test/cli/tui/draft.test.ts --timeout 30000
```

| Test file | Guards |
|-----------|--------|
| `opencode/test/session/format-activity.test.ts` | `formatActivity()` in both AI SDK and Claude SDK processor paths |
| `opencode/test/permission/next.test.ts` | `fromConfig` + `merge` with mixed string/object permission forms (upstream file, Dispatch tests appended) |
| `opencode/test/permission/subagent-hook.test.ts` | Subagent permission derivation / seeding |
| `opencode/test/server/session-directory.test.ts` | `withSessionInstance` on all session handlers (abort, prompt, command, shell) |
| `opencode/test/server/session-creation-directory.test.ts` | Sessions store their creation directory, retrievable from any Instance context |
| `opencode/test/server/event-cross-directory.test.ts` | GlobalBus cross-directory event bridge and duplicate prevention |
| `opencode/test/server/git-repos.test.ts` | The `/experimental/git-repos` endpoint |
| `opencode/test/provider/sdk-models.test.ts` | `SDK_MODELS` and `buildSdkModel` output |
| `opencode/test/claude-sdk/adapter.test.ts` | `normalizeTool`, `snakeToCamel`, `normalizeInput` — SDK→TUI transformation |
| `opencode/test/claude-sdk/error-extraction.test.ts` | `extractErrorMessage` — HTTP status detection and error shapes |
| `opencode/test/claude-sdk/token-counting.test.ts` | Tokens set from SDK result totals, not accumulated per stream event |
| `opencode/test/claude-sdk/session-map.test.ts` | SDK session UUID persistence (set/get/remove/disk) |
| `opencode/test/claude-sdk/pending-meta.test.ts` | `popPendingMeta` pop semantics for race-condition metadata |
| `opencode/test/claude-sdk/permission.test.ts` | `canUseTool` bridging, ExitPlanMode routing, background-task forcing |
| `opencode/test/claude-sdk/message-map.test.ts` | SDK message ID ↔ Dispatch part mapping |
| `opencode/test/claude-sdk/session-loop.test.ts` | Claude SDK turn loop behaviour |
| `opencode/test/command/dispatch-commands.test.ts` | `/deepReview` and `/merge` constants and `hints()` |
| `tui/test/cli/tui/draft.test.ts` | Draft save/restore lifecycle, auto-submit prevention, permission dialog cycle |

`packages/tui/test/keymap.test.tsx` is upstream's, but it covers the mode stack the dialog/leader guards depend on — worth running too.

## Verifying a Merge

> **The test suite has repeatedly been fully green while the app was completely broken.** Both Claude SDK outages described in the AsyncLocalStorage pitfall shipped with 100% passing tests. A merge is **not done** until you have launched the TUI and round-tripped a real prompt on **both** the Claude SDK path and the AI SDK path. Nothing below substitutes for that.

```bash
# 1. Typecheck
cd packages/opencode && bun typecheck

# 2. Run the Dispatch regression tests (both commands above)

# 3. Verify Dispatch features are present (each of these must print matches)
rg -n "formatActivity" packages/opencode/src/session/processor.ts
rg -l "claude-agent-sdk" packages/opencode/src/session/
rg -n "AgentEntry" packages/tui/src/routes/home.tsx
rg -n "withSessionInstance" packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts
rg -n "Instance.restore" packages/opencode/src/session/prompt.ts
rg -n "Dispatch: prefer the AsyncLocalStorage instance context" packages/opencode/src/effect/run-service.ts

# 4. Confirm nothing points at the old tree
rg -n 'src/cli/cmd/tui|server/instance/session|withSessionDirectory|from "@opencode-ai/core/util/log"' \
  packages/opencode/src packages/tui/src
# Must return nothing

# 5. MANUAL: launch the TUI and actually prompt
#    - Claude SDK path: start an agent session, submit a prompt, confirm streaming + a tool call
#    - AI SDK path: same, on a non-Claude-SDK model
#    - Approve a permission from the dashboard (exercises globalPending)
#    - Press `t` (PTY attach) and `D` (diffview) on a worktree agent
tail -f ~/.local/share/opencode/log/dev.log
```

**A note on verification commands.** The previous version of this document silently passed its own checks for months because half its greps pointed at files that no longer existed — "no matches because the invariant holds" and "no matches because the file is gone" are indistinguishable.

Every `rg` here now names a concrete file path rather than a directory, which is what makes the failure loud: `rg PATTERN missing/file.ts` exits **2** and prints `IO error ... No such file or directory`, while a genuinely clean check exits **1** and prints nothing. Several checks additionally assert on match counts. When you add a check, run it, then delete a character from the path and run it again — if the two runs look the same, rewrite the check.

## Release Cleanup (Optional)

For a clean release history, do a one-time rebase:

```bash
git checkout -b release-clean claudesdk
git rebase upstream/dev
# rerere auto-resolves most conflicts
```

This is optional — the merge-based history is fine for day-to-day development.
