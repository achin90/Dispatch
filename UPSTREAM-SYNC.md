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

### Effect framework migrations
Upstream is actively migrating to Effect's `Context.Service` pattern (from the older `ServiceMap.Service`). When merging, watch for:
- `ServiceMap` imports that need to become `Context`
- `InstanceState.withALS` calls that were removed (use direct service calls instead)
- Facade functions that were removed (upstream removes `runPromise` wrappers as they migrate to full Effect)
- `Layer.unwrap(Effect.sync(...))` → `Layer.suspend(() => ...)`

### Server API changes
Upstream changed `Server.Default()` to return `{ app, runtime }` instead of just the Hono app. Tests that call `Server.Default()` need `.app`.

## Verifying a Merge

After resolving conflicts:

```bash
# 1. Typecheck
cd packages/opencode && bun typecheck

# 2. Verify Dispatch features are present
grep -r "formatActivity" src/session/processor.ts    # Activity display
grep -r "claude-agent-sdk" src/session/              # Claude SDK
grep -r "AgentEntry" src/cli/cmd/tui/routes/home.tsx # Dashboard
grep -r "withALS\|withSessionDirectory" src/         # Directory context

# 3. Check logs after running (logs at ~/.local/share/opencode/log/)
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
