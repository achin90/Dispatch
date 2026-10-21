# Upstream sync

Dispatch is a fork of [opencode](https://github.com/anomalyco/opencode). This file is the one place an
upstream-merge agent reads to learn every Dispatch divergence: what it is, where it lives, why it
exists, and what breaks if a merge drops it.

Since the v2 migration almost all fork code is isolated:

- server side: `packages/dispatch` (`@opencode/dispatch`), described in `packages/dispatch/AGENTS.md`;
- TUI: `packages/tui/src/feature-plugins/dispatch` and `packages/tui/src/feature-plugins/jarvis`;
- small edits in upstream files, almost all marked with a `// Dispatch:` comment.

The design doc for the Claude Agent SDK runner is `CLAUDE-SDK-MIGRATION.md`. The migration record
(what was ported, what was dropped, what was verified) is `dispatch-docs/MIGRATION-PLAN.md`.

## 1. Merging upstream

### Remotes and branches

- `origin` is `https://github.com/achin90/Dispatch.git`, `upstream` is `https://github.com/anomalyco/opencode.git`.
- Upstream v2 is the `upstream/dev` ref. The fork's working branch is `Dispatch-opencodev2`.
- The pre-v2 fork is tagged `dispatch-v1-final`. Read old files with `git show dispatch-v1-final:<path>`;
  never check the tag out.

Set these once per clone. They are not defaults:

```bash
git config merge.renameLimit 999999
git config diff.renameLimit 999999
git config rerere.enabled true
git config --get rerere.enabled   # must print: true
```

### How the v2 jump was done (one time only)

The v1 fork could not be merged into v2: upstream rewrote everything (`packages/opencode` is gone).
So the branch was reset to upstream's tree and the fork was rebuilt on top. The record is in
`dispatch-docs/MIGRATION-PLAN.md`, section "Phase 0 record": tag `dispatch-v1-final` on `137879b0ef`,
then merge commit `a27db4d6bf` with parents `137879b0ef` (v1) and `3a1f9a934f` (upstream) whose tree is
upstream's. Because that merge has both parents, git now treats upstream as already merged up to
`3a1f9a934f`, and later merges are incremental. Do not repeat the tree swap.

### Routine merges

Fork code no longer lives inside upstream files, so a plain merge should work:

```bash
git fetch upstream
git log --oneline HEAD..upstream/dev | wc -l   # how far behind
git merge upstream/dev
```

Files that are expected to conflict, because both sides edit them:

| File | What Dispatch changed |
|---|---|
| `packages/server/src/process.ts` | imports `DispatchOverrides` and passes `DispatchOverrides.replacements` to `createRoutes(...)` |
| `packages/server/package.json`, `packages/server/tsconfig.json` | `@opencode/dispatch` dependency and project reference |
| `packages/core/src/mcp/index.ts` | `health()` on `Mcp.Interface`, `RECONNECT_DELAYS`, `reconnectDropped`, reconnect fork in `onClose` |
| `packages/core/src/mcp/client.ts` | `ping` on `Connection`; `client.onerror` closes the client after connect |
| `packages/core/src/plugin/provider/dynamic.ts` | skips `@opencode/dispatch/*` packages |
| `packages/core/src/config.ts` | `update` writes every key the patch names (`shell`, `advisor`) |
| `packages/core/src/config/normalize.ts` | keeps `advisor` through normalization |
| `packages/schema/src/config.ts` | `advisor` on `Config.Info`; every `Config.Patch` field optional |
| `packages/plugin/src/tui/context.ts` | `DashboardAgent`, `State`, and `state` on the TUI plugin `Context` |
| `packages/tui/src/plugin/api.tsx` | builds `context.state` from Dispatch storage keys |
| `packages/tui/src/plugin/builtins.ts` | registers the `Dispatch` and `Jarvis` feature plugins |
| `packages/tui/src/context/session-tabs.tsx` | dashboard agents' sessions are added to `keep` so their transcripts stay loaded |
| `packages/tui/src/routes/session/permission.tsx` | `reject` always goes to the reason stage |
| `packages/tui/src/context/args.tsx`, `packages/tui/src/config/keybind.ts` | `noDashboard` arg; `session.dashboard` on `<leader>d` |
| `packages/tui/src/attention-sounds.bun.ts`, `attention-sounds.node.ts`, `packages/cli/src/node/target.ts` | Jarvis `voiceReadySoundPath` chime (no `// Dispatch` marker; the comments say "Jarvis") |
| `packages/tui/package.json` | `kokoro-js`, `sherpa-onnx-node` (Jarvis) |
| `packages/cli/*` | branding and packaging, see the packaging row in section 2 |
| `packages/script/src/index.ts` | release version comes from GitHub `achin90/Dispatch` tags, not npm |
| `.github/workflows/*` | `if: github.repository == 'anomalyco/opencode'` guards; `release.yml` is Dispatch's |
| root `package.json` | `dev:live` / `dev:vite:live` call `dispatch service ...` |
| `bunfig.toml` | `minimumReleaseAgeExcludes` lists `@anthropic-ai/claude-agent-sdk` and its platform packages |
| `.gitignore` | `packages/dispatch/src/sdk/bin.gen.ts` (never on disk; the build serves it from a Bun plugin) |
| `README.md`, `install`, `install-from-source` | Dispatch's own |

Two kinds of conflicts are never resolved by hand:

- `packages/client/src/effect/api/api.ts`, `packages/client/src/effect/generated/*` and
  `packages/client/src/promise/generated/*` are generated. Take upstream's side, then run
  `cd packages/client && bun run generate` so the `Config.Patch` change (`advisor`) comes back.
- `bun.lock`: take either side, then run `bun install` at the root.

The `// Dispatch` marker grep (`rg -n "// Dispatch" packages --glob '!**/node_modules/**'`) finds most
fork edits, but not all. Unmarked fork-owned files: the attention-sound and `node/target.ts` Jarvis
lines, `packages/server/package.json`, `packages/tui/package.json`, workflows, `install`,
`install-from-source`, `README.md`, `.github/workflows/release.yml`. For the full list of files the
fork touches, run `git diff --stat upstream/dev...HEAD`.

### Resolving conflicts

1. Understand both sides: `git log upstream/dev --oneline -- <file>` and `git log --oneline -- <file>`.
2. Keep upstream's architecture and re-apply the Dispatch edit on top. Every edit is small on purpose.
3. If upstream now provides what Dispatch added (for example an MCP reconnect loop, or a `health`
   endpoint), drop the Dispatch version and use upstream's.
4. Before deciding upstream deleted something, search for it: `rg -n "<symbol>" packages/`.
5. Run the checks in section 4, then commit the merge.

## 2. Features, where they live, and what to watch

`packages/dispatch/AGENTS.md` is the authoritative description of the server code; this table is the
merge-time view.

| Feature | Files | Upstream touch points | Invariants and pitfalls |
|---|---|---|---|
| **Wiring** | `packages/dispatch/src/overrides.ts`, `location.ts`, `plugin/register.ts` | `packages/server/src/process.ts` (`createRoutes(..., DispatchOverrides.replacements)`); `SessionRunnerLLM.node` in `packages/core/src/session/runner/llm.ts`; `SdkPlugins.node` in `packages/core/src/plugin/sdk.ts` | Every server entry (`serve`, `serve --stdio`, managed service) goes through `ServerProcess.start`, so one edit covers all. `LayerNode.compile` silently ignores a replacement whose source node is not in the graph: if upstream renames or splits `SessionRunnerLLM.node` or `SdkPlugins.node`, Dispatch turns off with no error. Symptom: Anthropic sessions run on the stock runner, every step is a tool-free one-turn `query()` from the SDK language model, and no tools ever run. |
| **Claude Agent SDK runner** | `packages/dispatch/src/runner/node.ts`, `writer.ts`, `router.ts`, `query.ts`, `permission.ts`, `mcp.ts`; `packages/dispatch/src/sdk/*` | `SessionRunner.Service` drain contract, `SessionInbox`, `InstructionState`, `SessionContext`, `createLLMEventPublisher` (`core/src/session/runner/publish-llm-event.ts`), `Permission.Service`, `Form.Service`, `Mcp.Service` | Deliberately breaks the root AGENTS.md "one `llm.stream` per step" rule; see `CLAUDE-SDK-MIGRATION.md`. `runner/node.ts` depends on `SessionRunnerLLM.node.mapLayer((layer) => layer)`, a fresh node identity; depending on the original would resolve back to the replacement. `settleStaleCompactions` and `settleStaleToolCalls` are copies of unexported helpers in `core/src/session/runner/llm.ts`, and `SdkQuery.prompt` copies the shell-result wording from `core/src/session/runner/to-llm-message.ts`; when upstream changes those, update the copies. One publisher is one assistant message with exactly one `step-finish` (a second is `Effect.die("Duplicate step finish")`). Tokens per message are that API call's usage, replaced, never summed. Any service an SDK callback needs must be in the runner node's `deps`, or the captured context will not have it (`test/boundary.test.ts`). |
| **Permission bridge** | `packages/dispatch/src/runner/permission.ts`, `sdk/adapter.ts` | `Permission.Service.assert`, `DeclinedError`, `CorrectedError`, `BlockedError` (`core/src/permission.ts`); `FileAccess`; `ShellParse`; `Form.Service.ask` | A plain decline is a defect upstream; the bridge runs `assert` under `Effect.exit` and answers the SDK with `interrupt: true`. Feedback becomes "User rejected permission with the following feedback: …". Write/Edit/MultiEdit/NotebookEdit ask for action `edit`; Bash asks `shell` per parsed command. `AskUserQuestion` becomes a form with `metadata.kind: "question"`. Subagent calls go through the PreToolUse hook, which forces `run_in_background: false` on `Agent`/`Task` and applies the parent's rules (any deny wins, all allow allows, else ask). `Permission.evaluate` uses `findLast`, so the last matching rule wins. |
| **Session resume** | `packages/dispatch/src/sdk/session-map.ts` | `Session.Service.setMetadata`; metadata inheritance on child/fork | Stored as `Session.metadata["dispatch.sdk"] = { sessionID, uuid, cwd }`. Children and forks inherit metadata, so the entry only counts for the Session it names. Resume always uses the stored `cwd`. "No conversation found" before any output drops the entry and retries without resume. Subagent children are created with `metadata: {}` for the same reason. |
| **Models and single-shot calls** | `packages/dispatch/src/plugin/models.ts`, `sdk/models.ts`, `sdk/language-model.ts` | `ctx.provider.transform`, `ctx.model.transform`, `ctx.aisdk.hook("sdk")`; `core/src/plugin/provider/dynamic.ts` | Every Anthropic model (the six static aliases and every catalog Anthropic model) is pointed at package `aisdk:@opencode/dispatch/claude-agent-sdk`. `dynamic.ts` must skip `@opencode/dispatch/*` or core tries to npm-install it. Every 1M Opus alias keeps the `[1m]` suffix; Sonnet 5 is native 1M and rejects it. Default is `opus-5-5`; `default` is hidden with `status: "deprecated"`. Effort variants are `low/medium/high/xhigh/max` for summarized-thinking models. |
| **MCP reconnect and health** | `packages/core/src/mcp/index.ts`, `packages/core/src/mcp/client.ts`; SDK proxy in `packages/dispatch/src/runner/mcp.ts` | `Mcp.Interface`, `Connection`, `onClose`, `startServer`/`stopServer` | Lives in core because the connection table is private to `Mcp.Service`. Backoff `[5s, 10s, 30s, 60s, 60s…]` forever until connected, replaced, `needs_auth` or disconnected. `client.onerror` closes the client after connect so `onclose` fires (the MCP SDK error path never fires it). `health()` pings with a 5s timeout and restarts dead servers. Upstream `connect()` clears `disabled` and `disconnect()` sets it, so a user connect overrides config `disabled`. The SDK proxy: fresh `createSdkMcpServer` objects per query (MCP is point-to-point), tool definitions cached from the last good listing, status checked before every call, servers with status `disabled` excluded (`6d718c110b`), waits up to 10s for `pending` servers. If upstream adds its own reconnect loop, drop Dispatch's. |
| **Advisor** | `packages/schema/src/config.ts`, `packages/core/src/config.ts`, `packages/core/src/config/normalize.ts`; read in `packages/dispatch/src/runner/node.ts` (`advisor()`); TUI `packages/tui/src/feature-plugins/dispatch/dialog-advisor.tsx` | `Config.Info`, `Config.Patch`, `config.update`, `PATCH /api/experimental/config`, generated client `ConfigUpdateInput` | Without the `normalize.ts` line the key is dropped silently. `config.update({ advisor })` rewrites the global config file and every Location's Config reloads through its file watch; Locations are not reloaded. `"off"` or unset disables; `null` in the patch removes the key. The runner reads it each turn. |
| **Agents** | `packages/dispatch/src/plugin/agents.ts`, `plugin/agent/assistant.txt` | `ctx.agent`; upstream `core/src/plugin/agent.ts` and `core/src/plugin/plan.ts` | `build` asks on `shell`/`edit`; `yolo` and `assistant` allow `*`. `plan` is removed. Order build → yolo → assistant falls out of insertion order because these plugins run after `opencode.agent`/`opencode.plan`; if upstream changes plugin order, the switcher order changes. |
| **Commands** | `packages/dispatch/src/plugin/commands.ts`, `plugin/command/deep-review.txt`, `plugin/command/merge.txt` | `ctx.command` | `$ARGUMENTS` is replaced, else arguments are appended. |
| **Worktree strategy** | `packages/dispatch/src/plugin/worktree.ts` | `ctx.worktree.transform`; `core/src/worktree/strategies.ts` | Becomes the default by registering last. Creates `<parent of repo>/<repo>-<slug>` on a new branch `<slug>` (no `opencode/` prefix), with `-2`, `-3`… on collision. `remove` deletes the branch too. Worktrees from the stock `git` strategy keep being removed by it. |
| **`dispatch` RPC** | `packages/dispatch/src/rpc/definition.ts`, `rpc/node.ts`, `rpc/git.ts`, `rpc/github.ts`, `rpc/last-response.ts` | `Rpc.Service` (`core/src/rpc.ts`), `POST /api/rpc/:rpcID/:method` | Replaces v1's `/experimental/*` routes, so no protocol change and no client regeneration. A location node, not a plugin, because `mcp.health` and `session.lastResponse` need core services. `directory`/`cwd` default to the request's Location. `definition.ts` imports only `effect` and `@opencode/schema` so the TUI can import it. |
| **claude.ai bridge** | `packages/dispatch/src/bridge/*` | `@anthropic-ai/claude-agent-sdk/bridge` (alpha), `SessionExecution.interrupt`, `SessionEvent.Deleted` | RPC id is `dispatch-bridge`, not `dispatch`: one RPC id resolves to its last registration only. Mapping in `Session.metadata["dispatch.bridge"]`. Runner hook points are marked `// Dispatch bridge:` in `runner/node.ts` and `runner/permission.ts`. Inbound phone prompts switch the Session to `yolo`. Every mirror call is best effort and must never fail a local turn. |
| **Agent dashboard** | `packages/tui/src/feature-plugins/dispatch/` (`index.tsx`, `dashboard.tsx`, `watch.tsx`, `model.ts`, `create.ts`, `rpc.ts`, `state.ts`, `dialog-*.tsx`) | `packages/tui/src/plugin/builtins.ts`, `plugin/api.tsx`, `context/session-tabs.tsx`, `config/keybind.ts`, `context/args.tsx` | Agent list is TUI storage key `plugin.dispatch.agents`; agent sessions also get `Session.metadata["dispatch.agent"]`. `session-tabs.tsx` and `plugin/api.tsx` import `feature-plugins/dispatch/model`; keep those imports through upstream edits. Busy activity ("Shell pwd", "Thinking…") is derived on the client in `model.ts` from the session's messages; there is no server activity field. `/dashboard`, `/advisor`, `/remote`, `/remote-stop` and "Hide/Show agent summaries" are registered in `watch.tsx`. `--no-dashboard` hides it. |
| **TUI plugin state API** | `packages/plugin/src/tui/context.ts`, `packages/tui/src/plugin/api.tsx` | TUI plugin `Context` | `context.state.home.selectedSessionID()`, `state.agent.{current,list,set}`, `state.dashboard.agents()`. Jarvis depends on it. |
| **Reject with reason** | `packages/tui/src/routes/session/permission.tsx` | `PermissionPrompt` | Upstream only asks for a reason on child sessions. Dispatch always does, so the model gets the feedback. |
| **Jarvis voice** | `packages/tui/src/feature-plugins/jarvis/*` | `packages/tui/src/plugin/builtins.ts`, attention sounds, `packages/tui/package.json` | Speech models and native audio load only when voice mode is turned on. Needs `ffmpeg`; models download to `~/.jarvis/models`. |
| **Packaging, service identity, updater** | `packages/cli/script/build.ts`, `packages/cli/bin/dispatch.cjs`, `packages/cli/package.json`, `packages/cli/src/commands/commands.ts`, `commands/handlers/default.ts`, `commands/handlers/upgrade.ts`, `src/index.ts`, `services/updater.ts`, `services/service-config.ts`, `packages/script/src/index.ts`, `.github/workflows/release.yml`, `install`, `install-from-source` | upstream build script, updater, service registration | Binary `dispatch`, artifacts `dispatch-tui-<os>-<arch>`, user agent `dispatch/<version>`. Channel `dispatch` (previews `dispatch-<channel>`) keeps the service apart from a stock opencode: `service-dispatch.json`, default port 13823, database `opencode-dispatch.db` (`OPENCODE_DISABLE_CHANNEL_DB=1` restores the shared one). `service-config.ts` must never adopt stock `service.json`. `Updater.disabledLayer` replaces the managed updater, and with no update source the TUI hides `/update`. Release highlights are never embedded. Dev runs keep `OPENCODE_CLI_NAME` unset and print `opencode vlocal` so upstream CLI tests pass. The build embeds the `claude` binary from `@anthropic-ai/claude-agent-sdk-<os>-<arch>` through a Bun plugin serving `./bin.gen.ts`; `packages/dispatch/src/sdk/bin.ts` extracts it at runtime. |

## 3. Lost on purpose in v2

These v1 fork features were not ported because v2 does the job another way. Do not bring them back.

| v1 feature | Why it existed | v2 replacement |
|---|---|---|
| `withSessionInstance` / `withSessionInstanceOptional` and the ALS pieces (`Instance.restore`, `Instance.bind`, ALS-first `attach()` in `effect/run-service.ts`) | session routes and SDK callbacks had to run in the session's directory | `SessionLocationMiddleware` (`packages/server/src/middleware/session-location.ts`) runs session routes at the session's Location; SDK callbacks run through a context captured in the runner layer (`Effect.runPromiseWith`) |
| Cross-directory event bridge (`handlers/event.ts`, `bus/global.ts`, no-filter comment in `context/event.ts`) | worktree agents' events were invisible to the TUI | `packages/server/src/event-feed.ts` is not location-filtered; the TUI filters client-side |
| Permission `globalPending` | dashboard y/n could not reach a worktree agent's request | `session.permission.reply` runs under the session-location middleware |
| Question global `index` | same, for questions | forms (`packages/core/src/form.ts`) with `FormLocationMiddleware` (`packages/server/src/middleware/form-location.ts`) |
| Queued messages, UNSENT badge, leader+u undo guard, single-message `cancel` restore | v1 had no real queue | v2 inbox steer/queue (`packages/core/src/session/inbox.ts`) |
| PTY attach (`util/pty.ts`, dashboard `t`) | drop into a shell in the agent's worktree | persistent terminal pane (`terminal.toggle`, `<leader>t`); dashboard `t` opens the session and toggles it |
| Diffview route (`routes/diffview.tsx`, dashboard `D`) | per-worktree diff | v2 diff viewer (`packages/tui/src/feature-plugins/system/diff-viewer.tsx`, `diff.open`); dashboard `D` opens the session's viewer |
| Draft save/restore (`draft.ts`, `bind`/`boundSessionID`) | the permission prompt unmounted the composer | v2 per-tab prompt drafts (`packages/tui/src/component/prompt/draft-stash.ts`) |
| Plan-mode leftovers (`tool/plan.ts`, `plan.txt`, ExitPlanMode three-way switch) | plan mode was replaced by `assistant` | `plan` is an upstream plugin agent; `packages/dispatch/src/plugin/agents.ts` removes it |
| `cli/upgrade.ts` early return | stop the opencode updater | `Updater.disabledLayer` in `packages/cli/src/services/updater.ts` |
| `claude-sdk-session-map.ts` side file (`sdk-sessions.json`) | remember the SDK conversation per session | `Session.metadata["dispatch.sdk"]` (`packages/dispatch/src/sdk/session-map.ts`) |
| `bridge-sessions.json` side file | remember the claude.ai session | `Session.metadata["dispatch.bridge"]` (`packages/dispatch/src/bridge/mapping.ts`) |
| `util/log-bridge.ts` | log from SDK callbacks without a fiber | `Effect.log*` through the captured runner context |
| `--standalone` (skip the dashboard) | collided with upstream's `--standalone` (private server) | `--no-dashboard` |
| Server-side `formatActivity` and the `activity` field on busy status | dashboard activity text | derived on the client in `packages/tui/src/feature-plugins/dispatch/model.ts` |
| 8 `/experimental/*` HttpApi routes, `/mcp/health`, `/session/:id/last-response`, `/session/:id/remote-control*` | dashboard data | `dispatch` and `dispatch-bridge` RPCs; no protocol edits |
| Global MCP state (no per-directory `InstanceState`) | MCP calls from SDK callbacks lost the directory | per-Location `Mcp.Service` plus captured context; revisit only if worktree agents visibly lose servers |
| Subagent ruleset seeding in `tool/task.ts` | subagents inherit the caller's rules | SDK subagents get the parent's rules in the PreToolUse hook (`subagentHook` in `packages/dispatch/src/runner/permission.ts`) |
| `# Worktree Agent Context` block in `session/system.ts` | merge guidance for worktree agents | none; the `/merge` command covers it |
| `/merge` `${path}` replace, `dialog-prompt.tsx` `mounted`, unused kv `agents` | vestigial | none |

## 4. Verification checklist

> A green test suite has shipped a broken app more than once. A merge is done only after a real
> prompt round-trips on the SDK path (an `anthropic/*` model) and on a non-Anthropic model.

### Typecheck and tests

```bash
bun run check                        # repo root: lint + typecheck, the canonical full check
cd packages/dispatch && bun typecheck && bun test
cd packages/core && bun typecheck && bun run script/test.ts test/mcp-reconnect.test.ts test/config/normalization.test.ts
cd packages/tui && bun typecheck && bun test test/feature-plugins
cd packages/server && bun typecheck
cd packages/cli && bun typecheck
cd packages/plugin && bun typecheck
cd packages/schema && bun typecheck
cd packages/client && bun run generate && git status --short src   # must show no changes after a clean merge
```

Tests never run from the repo root. `packages/core` tests go through `bun run script/test.ts` (sandboxed
HOME/XDG); it forwards extra arguments to `bun test`.

### Grep checks

Every check names a file, so a moved or deleted file exits 2 with an IO error instead of quietly
printing nothing. When you add a check, run it, then break the path and run it again; if both runs
look the same, rewrite it.

```bash
rg -c "DispatchOverrides" packages/server/src/process.ts                      # 2
rg -n "export const node" packages/core/src/session/runner/llm.ts            # the node Dispatch replaces still exists
rg -n "SessionRunnerLLM.node.replace" packages/dispatch/src/location.ts
rg -n "mapLayer\(\(layer\) => layer\)" packages/dispatch/src/runner/node.ts
rg -n "export const node" packages/core/src/plugin/sdk.ts
rg -n "SdkPlugins.node.replace" packages/dispatch/src/plugin/register.ts
rg -n "@opencode/dispatch/" packages/core/src/plugin/provider/dynamic.ts
rg -n "advisor" packages/core/src/config/normalize.ts packages/schema/src/config.ts packages/core/src/config.ts
rg -n "RECONNECT_DELAYS|health:" packages/core/src/mcp/index.ts
rg -n "ping:|client.onerror = " packages/core/src/mcp/client.ts
rg -n "Dispatch|Jarvis" packages/tui/src/plugin/builtins.ts                  # 6 lines: 2 comments, 2 imports, 2 entries
rg -n "DispatchModel" packages/tui/src/context/session-tabs.tsx packages/tui/src/plugin/api.tsx
rg -n 'setStore\("stage", "reject"\)' packages/tui/src/routes/session/permission.tsx
rg -n "readonly state: State" packages/plugin/src/tui/context.ts
rg -n "session.dashboard" packages/tui/src/config/keybind.ts
rg -n "noDashboard" packages/tui/src/context/args.tsx packages/cli/src/commands/commands.ts packages/cli/src/commands/handlers/default.ts
rg -n "disabledLayer" packages/cli/src/index.ts
rg -n 'startsWith\("dispatch"\)' packages/cli/src/services/service-config.ts
rg -n 'const binary = "dispatch"' packages/cli/script/build.ts
```

Also diff the copied runner helpers against upstream after every merge:

```bash
git diff ORIG_HEAD HEAD -- packages/core/src/session/runner/llm.ts packages/core/src/session/runner/to-llm-message.ts
# any change to settleStaleToolCalls, settleStaleCompactions, the drain loop or the shell wording
# needs the same change in packages/dispatch/src/runner/node.ts or runner/query.ts
```

### Live checks

Use the background service (`dispatch service status` prints its URL, `dispatch service get password`
its password; `bun run dev:live` attaches a worktree TUI to the same server). The server uses HTTP
Basic auth with user `opencode`.

```bash
URL=$(dispatch service status); AUTH="opencode:$(dispatch service get password)"
DIR=$PWD

# dispatch RPC: body {"input": …}, Location in the x-opencode-directory header; response is {"output": …}
curl -s -u "$AUTH" -X POST "$URL/api/rpc/dispatch/worktree.diffstat" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"input":{}}'
curl -s -u "$AUTH" -X POST "$URL/api/rpc/dispatch/gitRepos.list" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"input":{"root":"'"$HOME"'/Documents"}}'
curl -s -u "$AUTH" -X POST "$URL/api/rpc/dispatch/mcp.health" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"input":{}}'
curl -s -u "$AUTH" -X POST "$URL/api/rpc/dispatch-bridge/session.remoteControlList" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"input":{}}'

# approve a pending permission (list them with GET /api/session/:sessionID/permission)
curl -s -u "$AUTH" -X POST "$URL/api/session/$SESSION/permission/$REQUEST/reply" \
  -H "content-type: application/json" -d '{"decision":"once"}'

# advisor: set, then clear; check ~/.config/opencode/opencode.json(c) after each
curl -s -u "$AUTH" -X PATCH "$URL/api/experimental/config" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"advisor":"opus"}'
curl -s -u "$AUTH" -X PATCH "$URL/api/experimental/config" \
  -H "content-type: application/json" -H "x-opencode-directory: $DIR" -d '{"advisor":null}'

# MCP: connecting a config-disabled server connects it; disconnect sets it disabled again
curl -s -u "$AUTH" -X POST "$URL/api/experimental/mcp/$SERVER/connect" -H "x-opencode-directory: $DIR"
curl -s -u "$AUTH" -X POST "$URL/api/experimental/mcp/$SERVER/disconnect" -H "x-opencode-directory: $DIR"
```

End to end without the TUI: `bun run dev run --standalone -m anthropic/haiku "list the files here with a tool, then summarize"`
must stream text, show a tool call and its result, and record tokens; a second `run -s <id>` must
resume (the session's metadata gains `dispatch.sdk`). Repeat on a non-Anthropic model.

Manual TUI pass (`bun run dev:live` from the worktree): dashboard, create a worktree agent, approve its
permission from the dashboard, `t`, `D`, `i`, `/advisor`, `/remote`, Jarvis voice. Logs are in
`~/.local/share/opencode/log/`.
