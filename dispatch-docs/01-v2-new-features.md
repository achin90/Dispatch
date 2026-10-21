# OpenCode v2 — what's new vs v1 (research report)

Compared `upstream/dev` (CLI 2.1.2) against our old merge-base `4643e65ad6` (v1.18.18). Our fork's v1 product was `packages/opencode` plus the v1-era `packages/tui`. In v2 that becomes `packages/cli`, `tui`, `core`, `server`, `protocol`, `schema` and `ai`. Paths below are at upstream/dev unless marked v1.

Sources:
- Real v2 docs: `services/www/src/docs/content/*.mdx`. (`packages/web/src/content/docs` is the old v1 docs with small edits.)
- Migration guide: `services/www/src/docs/content/migrate-v1.mdx` — best single source for "removed/replaced".
- `CHANGELOG.md` covers v2.0.26 → v2.1.2.
- `packages/posts` are placeholders; there is no v2 launch post.

Tags: **[new]**, **[reworked]** (existed in v1, substantially changed), **[renamed]**.

---

## 1. CLI (`packages/cli/src/commands/commands.ts`, handlers in `packages/cli/src/commands/handlers/`)

**Architecture**
- **[new] Shared background service:** every client connects to one per-user server, discovered or started automatically. Root flag `--standalone` gives a private server; `--server <url>` targets any server. Files: `services/server-connection.ts`, `services/standalone.ts`, `services/service-registration.ts`; docs `cli/index.mdx`.
- **[new] `opencode service start|restart|status|stop|get|set|unset`:** manages the background server (hostname, port, password, cors, `env NAME VALUE`, `disabled true`, `remote`). Files: `handlers/service/*`, `services/service-config.ts`.
- **[new] `opencode pair [--url] [--remote] [--yes]`:** one-time connect links + QR for browser/app; `--remote` via OpenTunnel. Files: `handlers/pair.ts`, `services/remote-tunnel.ts`; server `packages/server/src/pairing`.
- **[new] `opencode reload`:** reload config without restart. `handlers/reload.ts`.
- **[new] `opencode api <operationID | METHOD path>`:** raw authenticated calls. `handlers/api.ts`.
- **[new] `opencode auth list|login|logout|export|import|switch`:** replaces v1 `providers`/`account`. Multiple accounts per integration. `handlers/auth/*`.

**Promoted / reworked**
- **[reworked] `opencode mini`:** top-level minimal UI (v1 `run --mini`). `handlers/mini.ts`, `packages/tui/src/mini/*`.
- **[reworked] `opencode run`:** non-interactive only; `--format json`, `-f/--file`, `--title`, `--thinking`, `--fork`; model as `provider/model#variant`; `--auto`, hidden `--yolo`/`--dangerously-skip-permissions`; creates the session if `--session` names a missing one. `handlers/run.ts`, `packages/cli/src/run/*`.
- **[reworked] Root `opencode [directory]`:** `-c`, `-s`, `--prompt`, `--auto`, `--standalone`, `--server`.
- **[new] `opencode session export [--sanitize]` / `session import <file|url> [--directory]`**; `session list` table/json. `handlers/session/*`.
- **[new] `opencode plugin list|add|check|update|remove`.** `handlers/plugin/*`.
- **[reworked] `opencode mcp add`:** `--url`, `--header`, `--env`, `--global`, `-- <command>`. `handlers/mcp/*`.
- **[reworked] `opencode stats`:** `--year`, `--all`, `--cost`, `--full`, `--limit`, `--json`.
- **[reworked] `opencode debug agents|config|paths [db|home|data|…]`.**
- **[reworked] `opencode serve`:** `--hostname`, `--port`, `--cors`, `--service`, `--stdio`; serves the embedded web UI.
- **[reworked] `opencode upgrade`:** managed self-update service (checks every 10 min, applies when idle). `handlers/upgrade.ts`, `services/updater`.
- **[reworked] `opencode uninstall`:** always keeps data; stops services and persistent PTYs.
- **[reworked] `opencode acp`:** ported to v2; `--login`, forms via elicitation, child sessions. `packages/cli/src/acp/*`.

**Env / diagnostics**
- **[new]** `OPENCODE_CLI_CONFIG_CONTENT`, `OPENCODE_DISABLE_FREE_MODELS`, `FORCE_HYPERLINK`.
- **[new]** `SIGPROF` CPU profiles, heap-snapshot signal (`cpu-profile.ts`, `heap.ts`), OTLP export.
- **[new]** `opencode2` binary alias.

## 2. TUI (`packages/tui/src`)

**Layout and navigation**
- **[new] Session tabs:** horizontal strip or vertical rail, per-cwd or global, `auto|on|off`; tab history, unread glow, reopen closed (Ctrl+Shift+T), Ctrl+1…0; context menu, per-tab prompt drafts, worktree labels. Files: `component/session-tabs.tsx`, `session-tabs-rail.tsx`, `context/session-tabs*.ts(x)`, `component/tab-pulse.tsx`.
- **[new] Persistent terminal pane:** PTYs that survive restarts; `<leader>t`, `<leader>down/up`. Files: `component/terminal-pane.tsx`, `context/session-terminals.tsx`, `ui/pane-resize*.ts(x)`; server persistent-pty API.
- **[new] Pane focus** (`<leader>left/right`) and plugin-owned right-side session panels. `component/panel-host.tsx`, `context/panel.tsx`.
- **[new] Composer tabs:** Subagents (list/open/interrupt/filter), Shell (background shell output, kill), Terminals; Down arrow opens the subagent picker. `routes/session/composer/{index,subagents-tab,shell-tab,terminals-tab}.tsx`, `component/dialog-shell-output.tsx`.
- **[new] Open menu (Ctrl+O, `/open`, `/projects`):** recent sessions + projects; sessions awaiting input first. `component/dialog-open.tsx`.
- **[new] Settings dialog (`/settings`)** for `cli.json`. `component/dialog-config.tsx`, `config/index.tsx`.
- **[new] Experiments dialog** and devtools bar (`debug.devtools`). `component/dialog-experiments.tsx`, `devtools-bar.tsx`.
- **[new] `/highlights`** after updating, `/update` dialog. `component/dialog-highlights.tsx`, `dialog-update.tsx`.
- **[new] Pair dialog (`/pair`, `/web`).** `component/dialog-pair.tsx`.
- **[new] `/restart`, `/reload`.**
- **[new] `/btw <question>`:** side question using session context, not added to history. `feature-plugins/prompt/btw.tsx`.
- **[new] `/cd`:** change the session's working directory. `prompt/directory-completion.ts`, `prompt/directory-recents.ts`, `ui/working-directory-actions.tsx`.
- **[new] `/stats`:** shareable stats poster. `feature-plugins/system/stats.tsx`.
- **[new] `/worktrees`:** create (Tab generates a name), move session into it (Ctrl+M), delete, refresh. `component/dialog-worktree-name.tsx`, `dialog-workspaces.tsx`.
- **[new] Session location shown below the prompt**, missing-location recovery. `routes/session/location-missing.tsx`, `context/location.tsx`.

**Prompt and composer**
- **[reworked] Steer vs. queue:** Enter while working steers the active turn; `<leader>Enter` / Option+Enter queues. `<leader>q` manages queued prompts; Ctrl+U undoes and Ctrl+D deletes a queued prompt.
- **[new] Ctrl+B sends blocking tools to the background.**
- **[new] Image previews** (`<leader>i`), clipboard image previews, expandable pasted text (`prompt.paste`), labelled mention autocomplete, skills attached to prompts, `@file#20-45` ranges. `component/dialog-image-preview.tsx`, `prompt/*`.

**Transcript rendering**
- **[new]** Mermaid diagrams and LaTeX as Unicode math. `packages/merman`, `packages/latex`.
- **[new]** Verbosity levels, related tool-call grouping, sequential thinking grouping, read ranges, streaming shell output, execute-call details dialog, retry countdown, token throughput, per-turn token diagnostics. `routes/session/{dialog-execute,group-view,grouping/*,activity-summary}.ts(x)`.
- **[new]** OSC 8 clickable links, semantic path truncation.

**Reworked v1 features**
- **[reworked] Undo/redo as staged revert:** `/undo` stages and returns the prompt to the composer; `/redo` cancels; next prompt commits.
- **[reworked] Timeline and fork:** `/timeline`, `/fork`.
- **[reworked] Session management:** rename (Ctrl+R), delete (Ctrl+D), pin (Ctrl+F), copy session ID; `/copy` copies last reply.
- **[reworked] Diff viewer (`/diff`):** docked side panel, `f` fullscreen, sources (`d`: branch, committed, working, last turn), hunk/file nav, mark reviewed (`m`), split/unified (`v`), image diffs; mouse-driven file tree. `feature-plugins/system/diff-viewer*.tsx`.
- **[reworked] Forms:** the v1 question tool is generalised into session forms (questions, MCP elicitation, plugins). `routes/session/form.tsx`, `mini/footer.form.tsx`.

**Theme, alerts, plugins, settings**
- **[new] V2 theme system** (`packages/theme`).
- **[reworked] Alerts:** notifications and sounds independent; `subagent_done` event; interactive toasts. `attention*.ts`, `context/attention.tsx`.
- **[reworked] Plugin manager (`/plugins`):** update checks, hot reload.
- **[new] Session permission mode:** `session.permissions: prompt|autoaccept` in `cli.json`; permission prompt can go fullscreen.
- **[new] Investigate an error in a new session.**
- **[renamed] Keybinds:** IDs are dotted (`session.tab.next`, `composer.shell.kill`, `diff.mark_reviewed`). `config/keybind.ts`; docs `cli/keybinds.mdx`.

**New slash commands vs v1:** `/open`, `/highlights`, `/settings`, `/update`, `/pair`, `/restart`, `/reload`, `/cd`, `/worktrees`, `/terminal`, `/btw`, `/plugins`, `/stats`. `/variants` aliases `/thinking`, `/effort`.

**`cli.json` setting groups** (`config/index.tsx`): `tabs.*`, `session.*` (sidebar, scrollbar, thinking, grouping, image_preview, tps, markdown, new_location, permissions), `diffs.*`, `mini.*`, `terminal.title`, `terminal.copy`, `highlights`, `animations`, `debug.*`, `experimental`, `prompt.paste`, `prompt.image_preview`, `prompt.editor`; renamed `leader.timeout`, `scroll.*`. Unknown settings rejected; file hot-reloads.

## 3. Server and API (`packages/protocol/src/groups/*`, `packages/server/src/handlers/*`)

Breaking rewrite: `/api/...`, generated OpenAPI, `@opencode/client`.
- **Sessions** (`groups/session.ts`): revert `stage/commit/DELETE`; inbox list/cancel/update; `background`, `interrupt`, `synthetic`, `shell`, `compact`, `generate`, `wait`, `log`, `context`, `diff`, `view`, `environment`, `move`, `switchAgent`, `switchModel`; `fork`, `import`/`export`, `stats`, `active`, archive filtering.
- **Forms:** `/api/form`, `/api/session/:id/form/*` (`groups/form.ts`).
- **Permissions:** pending requests + saved list/update/delete (`groups/permission.ts`).
- **Integrations/credentials:** key/external/OAuth/command connect, attempt status, `credential.activate`.
- **MCP:** add/remove/connect/disconnect at runtime; resource catalog (`groups/mcp.ts`).
- **Plugins:** list/check/update. **VCS:** init/status/diff/branches/base (`groups/vcs.ts`). **Worktrees:** list/create/remove/refresh; **Projects:** list/update.
- **Shells** (`/api/shell`), **PTYs** and experimental **persistent PTYs**.
- **Filesystem:** `fs.read` (streams, Range), `list`, `find`, experimental `write`.
- **Web search**, **experimental voice** (OpenAI Realtime, Grok Voice, Gemini Live), **experimental generate text**.
- **Server and locations:** `/api/info`, `/api/pair`, typed plugin RPC (`/api/rpc/:rpcID/:method`), `location.get`/`location.reload`, debug location evict, v1 migration status.
- **Config:** `config.update` (experimental), `config.shells`; `model.default`; `reference.list`, `skill.list`, `command.list`.
- **Runtime targets:** workerd/Cloudflare, Modal sandbox driver, web-standard fetch handler.

## 4. Sessions (`packages/core/src/session`)
- **[new]** Steering and queuing through a generic session inbox.
- **[new]** Background blocking tools; background shells notify when done.
- **[new]** Subagent jobs run in background by default; resumable via `sessionID`; subagents can pick a model.
- **[new]** Sessions resume after service restart with a continuation message.
- **[new]** Session moves to another directory/worktree at a safe boundary; location switches recorded.
- **[new]** Session warming (`warming`).
- **[reworked] Compaction:** whole-conversation summary keeping recent context by token budget; native provider compaction; manual via API; overflow recovery.
- **[new]** Output-token-limit continuation; split Gemini responses stitched.
- **[new]** Titles from first prompt; previous agent/model persisted; session ID in instructions; viewed/unread state.
- **[reworked] Snapshots:** per-step, staged restore.
- **[new]** Archiving restored; v1 data migrates into v2.

## 5. Agents and permissions
- **[reworked] Permissions are one ordered list:** `permissions: [{action, resource, effect}]`, last match wins. Actions renamed: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`. Saved approvals editable; per-session rules; `~`/`$HOME` expand.
- **[new] Shell permission scanner** (tree-sitter; experimental `portable_shell_scanner`).
- **[new] `policies`:** hard allow/deny for `provider.use`, `tool.use`, MCP, skills, plugins. `packages/core/src/config/plugin/policy.ts`.
- **[reworked] Agents:** `agents` map with `system`, `disabled`, `steps`, `request`, `model: "provider/model#variant"`. Built-ins: build, plan, general, explore, plus hidden title/summary/compaction. Plan is a plugin that may write only to `~/.opencode/plan` (`packages/core/src/plugin/plan.ts`). Agents/commands reload on config change.
- **[new]** `experimental.subagent_depth`; plugins can assert permissions and get permission-review hooks.

## 6. Tools (`packages/core/src/tool/plugin/*`)
- **[reworked] Code Mode (`execute`):** default way to reach MCP and deferred tools; per-server `codemode: false` opts out. `packages/codemode`.
- **[new] `opencode` Code Mode namespace:** `session_rename`, `session_move`, `worktree_create/list/remove`. `tool/plugin/opencode.ts`.
- **[new] `browser` namespace** (`packages/plugin-browser`).
- **[new]** `list_mcp_resources`, `read_mcp_resource`.
- **[reworked] `subagent`** (formerly `task`): background mode and resume.
- **[reworked] `shell`:** `background`, `workdir`, timeouts, bounded output.
- **[reworked]** `grep` `literal`/`caseSensitive`; `glob` `hidden`; `edit` more forgiving; `patch` only for GPT; malformed tool args repaired.
- **[reworked] `websearch`:** pluggable providers (Exa, Firecrawl, Parallel, Tavily, TinyFish).
- **[reworked] `webfetch`:** new Markdown renderer.

## 7. MCP, skills and plugins
- **MCP:** config at `mcp.servers` with `timeout.catalog/execution`; `protocol: legacy|auto|2026-07-28`; elicitation as forms; resources; server instructions in system prompt; session ID in `_meta`; pending status; OAuth client-metadata; runtime connect/disconnect. `packages/core/src/mcp`.
- **Skills:** discovered from `~/.claude/skills`, `~/.agents/skills`, project `.claude`/`.agents`; HTTP catalogs; `disable-model-invocation`, `metadata.opencode/autoinvoke`; built-in `opencode` and `report` skills.
- **Plugins:** new v2 plugin API (Effect and Promise) with hooks for sessions, permissions, shell, tools, requests, retry, title, compaction, WebSocket; durable storage; typed RPC; VCS/worktree/websearch providers (`packages/plugin`). Separate TUI plugin API: slots, routes, session panels, `ui.tabs`, dialogs, toasts (`packages/tui/src/plugin/*`). Git plugin packages, hot reload, bundled Figma plugin.

## 8. Providers and models
- **[reworked]** Native AI layer `packages/ai` replaces the AI SDK path; config `providers` with `package: "aisdk:…"`, `settings`, `headers`, `body`, `compatibility.*`.
- **[new] Native providers:** Alibaba, Meta, MiniMax, Moonshot, Cerebras, Together, Cohere, DeepInfra, Groq, Mistral, Venice, Vercel AI Gateway, Z.ai, Bedrock Mantle, Vertex. `packages/core/src/plugin/provider/*`.
- **[new] Local model discovery:** Ollama, LM Studio, vLLM.
- **[new] Auth methods:** Azure CLI, Google ADC, AWS profile chain, Copilot OAuth, GitLab OAuth, Poe, DigitalOcean, Snowflake Cortex, ChatGPT token-sharing, multiple accounts per integration.
- **[new]** Responses API over WebSocket, prompt cache across effort switches, variants as `#variant`, free-model toggle.
- **SDK-level only:** image, video, speech, transcription generation.

## 9. Worktrees, locations and projects
- **[new]** Locations as the unit of loaded services; `experimental.location_idle_timeout`; per-location reload; missing-location recovery.
- **[renamed/reworked]** v1 "workspaces" → worktrees: `worktree.directory` config, setup scripts, plugin-supplied strategies; agent suggests moving sessions into task worktrees; base-branch selection. `packages/core/src/worktree`, `packages/core/src/config/plugin/worktree.ts`.
- **[new]** Directory (non-Git) projects, Mercurial adapter, VCS branch info, projects ordered by activity, auto-archive of missing projects.
- **[new]** `AGENTS.md` discovery walks up to home; instructions discovered when directories are read.

## 10. Desktop and web (`packages/app`, `packages/desktop`)
- Embedded web UI with pairing/QR, PWA; desktop SSH connections, in-app browser; settings redesign; bottom terminal panel, `/btw` side panel, vertical tabs, Cmd+F; queue/steer; changed-files review panel; Office previews, Mermaid; device-flow sign-in; v1-server warning.

## 11. Other
- Docker images `ghcr.io/anomalyco/opencode:2.x`, Windows ARM64, `CHANGELOG.md`.
- `@opencode/client` with service discovery and optimistic prompt admission; `@opencode/sdk` embedded host.
- New top-level config keys: `policies`, `warming`, `websearch`, `worktree`, `update`, `snapshots`, `media`, `tool_output`, `formatter`.

---

## Removed or replaced from v1
- **Config renames (still read and normalised):** `permission`/`tools` → `permissions[]`; `agent`/`mode` → `agents`; `command` → `commands`; `subtask` → `subagent`; `provider` → `providers`; `plugin` tuples → `plugins` objects; `snapshot` → `snapshots`; `attachment` → `media`; `reference` → `references`; `skills.paths/urls` → `skills[]`; `compaction.preserve_recent_tokens/reserved` → `keep.tokens/buffer`; `autoupdate` → `update`; `small_model` → `agents.title.model`; `enabled_providers/disabled_providers` → policies.
- **Ignored with warning:** `compaction.tail_turns/prune`, `logLevel`, `server`, top-level `subagent_depth`, experimental `batch_tool`/`openTelemetry`/`primary_tools`, provider `whitelist/blacklist`.
- **Provider IDs merged:** `azure-cognitive-services` → `azure`, `google-vertex-anthropic` → `google-vertex`.
- **`tui.json(c)` → global `~/.config/opencode/cli.json`** (auto-migrated); project-local TUI config gone.
- **Plugin API and server API:** v1 plugins don't run; v1 server integrations must move.
- **CLI commands dropped:** `attach` → `--server`; `web` → `pair`/`serve`; `providers`/`account`/`console` → `auth`; top-level `export`/`import` → `session export/import`; `generate`, `github`, `pr`, `db`, `agent` removed; most `debug` subcommands removed; `mcp debug` removed.
- **Flags dropped:** root `--model`, `--agent`, `--fork`, `--mini`, `--replay`; `run` `--command`, `--share`, `--attach`, `--password`, `--username`, `--dir`, `--port`, `--variant`, `--interactive`, `--mini`; `serve` mDNS; `models` `--refresh`/`--verbose`; `uninstall --keep-*`.
- **Features removed:** session sharing; LSP; sidebar Files panel and home tips; `CLAUDE.md` fallback (only `AGENTS.md`); `scout` agent; batch tool.
- **Behaviour changed:** plan mode's `plan_enter/plan_exit` tools → a Plan primary agent (plugin); `todowrite` off by default (`experimental.todo`); `task` → `subagent`; `external_directory` no longer asks by default.
- **TUI removed:** `/timestamps`, `/thinking` (alias of `/variants`), `/workspaces`, `/move`, `/warp`, `/org`; keybinds `tips_toggle`, `app_heap_snapshot`, `console_org_switch`, `session_toggle_timestamps`, `session_toggle_generic_tool_output`, `messages_toggle_conceal`, `tool_details`, `workspace_set`, `app_toggle_session_directory_filter`, `plugin_install`; keyboard file-tree nav in diff viewer; all keybind IDs renamed to dotted names.
- **Platform:** v1 and v2 aren't installed side by side; Windows package managers unsupported for the CLI.
