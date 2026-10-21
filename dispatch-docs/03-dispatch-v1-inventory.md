# Dispatch fork inventory (opencode v1 → v2 re-implementation guide)

Worktree: `/Users/andy/Documents/Dispatch-opencodev2`. Fork range: `4643e65ad6..HEAD` (134 non-merge commits, 159 files, +17.7k/−0.9k). All paths below are relative to the repo root, and line numbers are from the current tree.

---

## 0. Four rules to carry into v2 before porting any file

1. **State that an agent writes and the TUI reads must be process-global.** An agent session runs in its own worktree directory. The TUI talks to the server from its launch directory (`x-opencode-directory`). So per-directory `InstanceState` lookups miss. Five stores are global for this reason:
   - the permission pending map (`globalPending`)
   - the question pending map (`index`)
   - MCP connections (module-level state, not `InstanceState`)
   - claude.ai mirror handles (`attached`)
   - the SDK session UUID map
2. **Session-scoped routes run in the instance that owns the session**, not the requester's (`withSessionInstance`). If this is missing, worktree agents silently run against the TUI's directory.
3. **Claude Agent SDK callbacks have no Effect fiber.** `canUseTool`, hooks, MCP proxy handlers, bridge inbound callbacks and stream processing are all plain async code. Context reaches them two ways:
   - passed explicitly (`instance: InstanceContext` threaded through `createClaudeSdkQuery`);
   - re-entered through AsyncLocalStorage (`Instance.restore`/`Instance.bind`, plus an `attach()` that prefers ALS over the fiber).
   This caused two total outages that showed up as a silently dead prompt, and the tests passed both times.
4. **Every worktree-targeting route must declare `query: WorkspaceRoutingQuery`.** Without it the generated SDK client silently drops `directory`.

---

## A. Claude Agent SDK integration (the core of the fork)

**What it does:** every `anthropic` provider model runs through `@anthropic-ai/claude-agent-sdk` `query()` instead of the Vercel AI SDK. The SDK owns the tool loop and its built-in tools. Dispatch translates its message stream into opencode `MessageV2` parts so the TUI looks unchanged. Auth comes from the existing Claude Code login (API key or subscription). Rationale: `CLAUDE-SDK-MIGRATION.md` and `packages/opencode/AGENTS.md`, which is also rewritten as an SDK bridge architecture doc.

### A1. Routing in `packages/opencode/src/session/prompt.ts`
- **~1207:** `const userCountBefore = msgs.filter(user).length`, then `if (model.providerID === "anthropic")` selects the SDK path. Everything else falls through to the AI SDK path (~1467).
- **Assistant message:** built manually, with `path: { cwd: ctx.directory, root: ctx.worktree }`. On step 1 it calls `summary.summarize`.
- **Queued messages (step > 1):** user text that arrived after `lastFinished` is wrapped in `<\system-reminder>The user sent the following message: … Please address this message and continue…<\/system-reminder>`.
- **Prompt building:**
  - The prompt is the last user message's non-synthetic text. It falls back to synthetic text, for example auto-continue after compaction.
  - Media parts (png/jpeg/gif/webp/pdf data URLs) become an `SDKUserMessage["message"]` with base64 `image`/`document` blocks.
- **System prompt:** `agent.prompt + sys.skills(agent) + instruction.system()`. `// ...env,` is deliberately commented out (commit c20f9834ac), so `SystemPrompt.environment` never reaches the SDK path.
- **Lazy imports:** `claude-sdk-query`, `claude-sdk-processor` and `claude-sdk-bridge` are dynamically imported to break the AppRuntime import cycle. The symptom of that cycle is a TDZ error: "Cannot access 'defaultLayer' before initialization".
- **MCP servers:** plugin tool server (`createPluginToolMcpServer(hooks, ctx.directory, ctx.worktree)`) plus `resolveMcpServers()`.
- **Compaction hand-off:** `compactRef: CompactionRef = {}` is filled by a `PostCompact` hook and read on `compact_boundary`.
- **Advisor:** `const advisor = (yield* config.getGlobal()).advisor`. It reads the **global** config on purpose (see B).
- **~1355:** `Instance.restore(ctx, () => createClaudeSdkQuery({...}))` with these options:
  - `model: model.api.id`, `cwd: ctx.directory`, `instance: ctx`, `maxTurns: isLastStep ? 1 : undefined`
  - `ruleset: Permission.merge(agent.permission, session.permission ?? [])`
  - `effort: lastUser.model.variant`
  - `contextWindow: model.limit.context`
  - `advisorModel: advisor && advisor !== "off" ? advisor : undefined`
  - `hooks.PostCompact`
- After that: `getMirror(sessionID)?.user(lastUser.id)` (claude.ai mirroring, section D).
- **~1394:** `Instance.restore(ctx, () => processClaudeSdkStream(sdkQuery, { assistantMessage, sessionID, abort, cwd, compaction: compactRef, setStatus: (sid,s)=>run.fork(status.set(sid,s)) }))`, plus `.pipe(Effect.onInterrupt(() => abortController.abort()))`. `run` is `EffectBridge.make()`.
- **~1412:** `if (agent.name === "plan")` post-turn ExitPlanMode detection. This is now **dead code** (see "vestigial").
- **~1458–1464:** loop exit. `result.outcome === "error"` breaks. Otherwise it reloads messages and `continue`s only if the user count grew past `userCountBefore`. Fix 70c6099c24: comparing message IDs (`id > last.id`) looped forever because IDs don't sort chronologically.
- **Layer wiring (~1911):** `Question.node` is added to the prompt layer's dependencies, and `const question = yield* Question.Service`.
- **`cancel` (~157–175)**, used by queued-message handling:
  - after `state.cancel`, find user messages after the last assistant message;
  - if there is **exactly one**, remove it, and the TUI restores its text into the prompt;
  - if there are several, leave them, and the TUI shows UNSENT badges.

### A2. `session/claude-sdk-query.ts`
- **`ClaudeSdkQueryInput` (~47):** prompt, sessionID, messageID, model, systemPrompt, cwd, permissionMode, allowed/disallowedTools, abortController, maxTurns, ruleset, effort, mcpServers, hooks, contextWindow, `advisorModel`, **required** `instance: InstanceContext` (45894fb327).
- **MCP proxy cache (~87–200):** `cachedDefs`, `dirty`, `flight`, `subscribed`.
  - `invalidateMcpCache()` only sets `dirty = true` and **never** clears `cachedDefs`.
  - `resolveDefs()` falls back to `cachedDefs?.[name]` when `listTools()` fails (30s timeout).
  - `createProxy(name, tools)` makes a **fresh** `createSdkMcpServer` per call. It installs raw `ListTools`/`CallTool` handlers, so the original JSON schemas are preserved.
  - The `callTool` handler checks `svc.status()[name]?.status !== "connected"` **before** `svc.clients()`.
  - `resolveMcpServers()` subscribes once to `MCP.ToolsChanged` through `EventV2Bridge` and invalidates. It resolves through `AppRuntime.runPromise(MCP.Service.use(...))`, which is global.
- **`createPluginToolMcpServer(hooks, cwd, worktree)` (~212), commit 7123cc7c61:**
  - Exposes `hooks.tool` plugin tools (for example opencode-scheduler) as an in-process MCP server named `PLUGIN_TOOL_SERVER_NAME = "opencode-plugins"`.
  - Zod args are converted with `z.toJSONSchema`.
  - `execute()` gets a stub ctx (`directory: cwd`, `worktree`, `ask: () => Effect.void`).
- **`resolveApiKey()` (~293):** checks `ANTHROPIC_API_KEY` env, then the Auth store `anthropic` with `type === "api"`. Otherwise it returns undefined and the SDK uses OAuth/subscription.
- **`createClaudeSdkQuery()` (~316):**
  - **Environment:**
    - `env = {...process.env, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ENABLE_TOOL_SEARCH: "false"}`.
    - The first var keeps the native 1M window when `ANTHROPIC_BASE_URL` points at a local proxy (b95fdc605d).
    - The second disables optimistic ToolSearch, whose empty results look like dead MCP (4cea002927).
    - Plus the API key when one was resolved.
  - **Resume:** `getSdkSessionEntry(sessionID)` supplies `resume` from the stored uuid plus the **original stored cwd**.
  - **Options passed to `query()`:**
    - `permissionMode: "default"` (not bypass, which would shadow `canUseTool`);
    - `pathToClaudeCodeExecutable: bin` when one is set;
    - `canUseTool: createCanUseToolBridge({sessionID,messageID,ruleset,instance})`;
    - `strictMcpConfig: true`, so the CLI does not load `.mcp.json`, `~/.claude.json` or claude.ai connectors (72eb21d63e);
    - `hooks.PreToolUse += createSubagentPermissionHook(ruleset, instance.worktree)`;
    - `settings.autoCompactWindow = clamp(contextWindow, 100_000, 1_000_000)`;
    - `settings.advisorModel`.
  - **Prompt:** a plain string, or an async iterable `SDKUserMessage` when media is present.
  - **Stale session:** on a "No conversation found" error, `removeSdkSessionID` and retry without resume.

### A3. `session/claude-sdk-permissions.ts`
- **`pending` map + `popPendingMeta(callID)` (~43):** holds edit diffs stashed before the ToolPart exists, which is a race. Covered by `pending-meta.test.ts`.
- **`extractPatterns` (~55) and `derivePermissionName` (~94):** map SDK PascalCase tools to opencode permission names. Write and Edit both map to `edit`; MCP tools are lowercased.
- **`normaliseFilePatterns(tool, patterns, worktree)` (~148):** relativises absolute paths inside the worktree so config rules match the AI SDK path. A worktree of `/` (non-git project) is skipped.
- **`checkExternalDirectory` (~172):** mirrors the `external_directory` gate with `containsPath(filePath, opts.instance)`. It asks for `external_directory` with pattern `dir/*`.
- **Synchronous subagents and permission propagation — `createSubagentPermissionHook(ruleset, worktree)` (~251).** It is wrapped in `Instance.bind` and runs as a PreToolUse hook.
  - **Synchronous subagents (add20f9054):** `Agent`/`Task` calls without `run_in_background === false` get `updatedInput.run_in_background = false`.
    - Why: a backgrounded task outlives the per-turn `query()`.
    - The SDK closes stdin at the first result and kills it.
    - The model then misreports this as "blocked on permissions".
  - **Permission propagation (812045415d):** subagent calls (those with `agent_id`) evaluate the parent ruleset.
    - Any deny → `deny`.
    - All allow → `allow`.
    - Otherwise `ask`, which the SDK re-routes to `canUseTool` with `agentID`.
    - Main-thread calls pass through to `canUseTool`.
- **`trimDiff` and `generateEditDiff`:** compute Edit/Write diffs with `createTwoFilesPatch`.
- **`AskUserQuestion` bridge — `question(input, opts, toolUseID, signal)` (~469):**
  - converts the SDK input to `Question.Info[]` and calls `Question.ask` with `tool:{messageID,callID}` (fed92f5a52);
  - returns `updatedInput.answers = {[questionText]: "a, b"}`;
  - also fans out to claude.ai when mirrored, via `writeRemoteQuestion`, `matchRemoteAnswer` and `remoteQuestionAnswerer` (section D).
- **`exitPlanMode` (~570):**
  - 3-option question: Build / Yolo / Stay in Plan, with `custom: false` (fed92f5a52 "plan-exit answer locking").
  - Background: free text used to fall through to "build", which approved a plan the user had declined.
  - On approval it creates a synthetic user message with `agent = yolo|build` and the text "The plan has been approved, you can now edit files. Execute the plan".
- **`markToolDenied`:** sets the part to `error` so the TUI strikes it through.
- **`updateToolMetadata`:** merges into running **or completed** parts. This is the multi-edit diff preservation fix (7a2987fe54); the diff is stashed in `pending` **before** awaiting approval.
- **`createCanUseToolBridge(options)` (~720), wrapped in `Instance.bind`:**
  - routes AskUserQuestion and ExitPlanMode as above;
  - gate 1 is the external directory check, gate 2 is `Permission.ask`;
  - metadata is `{toolName, title, agentID?, filepath, diff, input}`. `metadata.input` lets the TUI show subagent tool input whose part lives in an unsynced child session.
  - **Rejection feedback (69fd53d5e9):** `CorrectedError` produces "User rejected permission with the following feedback: …" instead of being collapsed into a plain rejection.
  - **Abort race:** if the abort signal wins, it calls `reply({reject})` to clean up `globalPending`.
  - **Mirror fan-out:** sends `askPermission` to the mirror only once `Permission.Event.Asked` fires for this `requestID`. In `finally` it calls `cancelPermission` and `state("running")`.

### A4. `session/claude-sdk-processor.ts`
- **`extractErrorMessage` (~42):** maps 500/5xx statuses to friendly messages.
- **`formatActivity(part)` (~59):** dashboard activity string.
- Local types for the system subtypes the SDK sends: `task_started`, `task_progress`, `task_notification`, `compact_boundary`.
- **`processClaudeSdkStream(messages, input)` (~177):**
  - `getMirror` is resolved per message (d196a2d52b) and the message is teed with `mirror.write`.
  - `assistant` → `processAssistantMessage`.
  - `result` → `finalizeRunningTools`, then `processResultMessage`, then `mirror.result(id)` and `state("idle")`.
  - `system:init` → `setSdkSessionID(sessionID, session_id, cwd)`.
  - Task subtypes go to their handlers.
  - Error and no-result exits abort running tools, including in child sessions, set the error, and call `endMirroredTurn`.
- **Reasoning duration:** `stepStart`/`arrivedAt` measures the window (45894fb327). This fixed the "Thought: 0ms" display.
- **`finalizeRunningTools(messageID, {skipAgentTools})`:** marks running parts completed and merges `popPendingMeta`. The top level skips agent/task tools (bf3dbb37a5).
- **`completeAdvisorCalls`:** described in B.
- **Subagents:** `createChildSession` (child session titled `"<desc> (@<agent> subagent)"`, plus a user and an assistant message). `updateAgentToolMetadata` sets `metadata.sessionId`, which makes the TUI Task component work. `resolveAgentName` lowercases `subagentType`.
- **Actual subagent model recording (de83191e48):** `normalizeWireModel` turns `claude-opus-5` into `opus-5`, and `syncSubagentModel` writes the model the SDK reports onto the child assistant message.
- **Task handlers:** `handleTaskStarted` sets the title, `handleTaskProgress` records `toolUses`/`lastToolName` metadata, `handleTaskNotification` sets completed or error.
- **Token counting — `processResultMessage` (~798):**
  - Tokens are set **once** from `SDKResultMessage.usage` totals.
  - `tokens.total` is the last top-level turn's input + cache_read + cache_write + output, which is the context size.
  - Never accumulate tokens per stream event.
  - TUI readers prefer `tokens.total`: `component/prompt/index.tsx`, `routes/session/subagent-footer.tsx`, `feature-plugins/sidebar/context.tsx`.
- **`handleCompactBoundary`:** writes a user compaction part and an assistant `summary:true` message containing `compactRef.summary`, then publishes `SessionCompaction.Event.Compacted`. It uses `assistantMessage.path.root`, not ALS.

### A5. `session/claude-sdk-adapter.ts`
- Pure mapping: `textBlockToPart`, `thinkingBlockToPart(…, time)`, `toolUseBlockToPart`.
- `normalizeTool` maps PascalCase to lowercase; `Agent` → `agent`, `CodeSearch` → `codesearch`.
- `snakeToCamel` and `normalizeInput` with `TOOL_OMIT_KEYS`:
  - read: limit/offset
  - edit: oldString/newString/replaceAll
  - write: content
  - bash: timeout/description
  - grep: include
- Advisor guards: `isAdvisorCallBlock`, `isAdvisorResultBlock`, `advisorResultState`.
- `assistantMessageToParts` and `resultMessageToMetadata`.

### A6. `session/claude-sdk-session-map.ts`
- Maps an opencode sessionID to `{uuid, cwd}` in `~/.local/state/opencode/sdk-sessions.json` (`Global.Path.state`). Bare-string entries are accepted for backward compatibility.
- `getSdkSessionEntry`, `getSdkSessionID`, `setSdkSessionID(sessionID, uuid, cwd)`, `removeSdkSessionID`.
- Resume must use the **original** cwd, or the SDK can't find its JSONL files.

### A7. `session/claude-sdk-bin.ts` and the build embed
- The runtime does `await import("claude-sdk-bin.gen.ts")` → `extractFromBunfs(mod.default)`. In dev the module is absent and the SDK resolves the binary itself.
- **`packages/opencode/script/build.ts`:**
  - `bun install --os="*" --cpu="*" @anthropic-ai/claude-agent-sdk@${pkg.devDependencies[...]}`;
  - per target, resolves `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]/claude[.exe]` from the SDK's **real** store dir. Fix 7bd90dc88e: Bun's isolated linker made it unresolvable otherwise.
  - injects `files: {"claude-sdk-bin.gen.ts": "import binPath from <abs> with { type: 'file' }; export default binPath"}`;
  - output goes to `dist/<name>/bin/dispatch` with user agent `dispatch/<version>`.
- `packages/opencode/script/postinstall.mjs` was rewritten for `dispatch-tui-<platform>-<arch>` packages and the binary `dispatch[.exe]`, cached at `bin/.dispatch`.

### A8. ALS bridge pieces
- **`project/instance.ts` (new):** `Instance.current/directory/worktree/project`. `bind(fn)` captures the ALS; `restore(ctx, fn)` rebuilds the ALS from an Effect-side `InstanceContext`.
- **`project/with-instance.ts` (new):** `WithInstance.provide({directory, fn})` loads `InstanceStore` and provides the ALS. Used by `lastResponse`.
- **`effect/run-service.ts` `attach()` (~26):** prefers `Instance.current` (ALS), catching `LocalContext.NotFound`, over `Fiber.getCurrent()`. Marker comment: "Dispatch: prefer the AsyncLocalStorage instance context".
- **`util/log-bridge.ts` (new):** `create({service})` returns debug/info/warn/error, which lazily import AppRuntime and run `Effect.log*`.
  - Exists because `@opencode-ai/core/util/log` was deleted upstream.
  - Consumers: claude-sdk-permissions, -processor, -query, -bridge, compaction, github.
- `bin`/`resolveApiKey` are also used by `session/summarize.ts` and `compaction.ts`.

### A9. SDK compaction — `session/compaction.ts` (~430–660)
- For `anthropic`:
  - resumes the SDK session (`getSdkSessionID`) and sends `/compact` (or `/compact <plugin prompt>`) with `maxTurns: 1` and a `PostCompact` hook;
  - streams until `compact_boundary`, then writes the summary text part and returns `continue`;
  - with no boundary it calls `removeSdkSessionID` and sets an error;
  - "prompt is too long" errors return `compact`;
  - tokens are reset to 0.
- Other providers take the AI SDK processor path.
- The end check became `if (result === "stop" || msg.error) return "stop"`.
- AppRuntime is lazy-loaded (`loadAppRuntime`).

### A10. Static SDK models — `provider/provider.ts`
- **`SDK_MODELS` (~1214):**

  | Alias | Resolves to | Context | Notes |
  |---|---|---|---|
  | `default` | `claude-opus-5-5[1m]` | 1M | hidden via `status:"deprecated"` (86b5098b79) |
  | `fable-5-1` | — | 1M | description "$10/$50 per Mtok" |
  | `opus-5-5` | `claude-opus-5-5[1m]` | 1M | |
  | `opus-4-6[1m]` | — | 1M | |
  | `sonnet` | `claude-sonnet-5` | 1M | native 1M, **no** `[1m]` suffix (the suffix is rejected) |
  | `haiku` | `claude-haiku-4-5-20251001` | 200k | output 8192, reasoning off |

  - Every 1M Opus entry must keep the `[1m]` suffix. A bare id makes the SDK report a 200k window and auto-compact early (26fca785a1).
  - History: a8733549f2 defaulted to Opus 5.5 and dropped older Opus aliases; b8cb1d5923 dropped Fable 5.
- **`buildSdkModel(alias, info, name)` (~1283):** `providerID anthropic`, `api.npm @ai-sdk/anthropic`, `options.sdkDescription` (shown in `dialog-model.tsx`), zero cost.
- **`sdkProvider()` (~1325):** sets variants with `ProviderTransform.variants`. These are the effort levels.
- **Merging:** `Provider.list` (~1806) and `getModel` (~1964 fast path) always merge the SDK models into `anthropic` (4c85cd4ab7 "always include Anthropic provider").
- **Effort levels — `provider/transform.ts` (~659–705):**
  - `SUMMARIZED_THINKING_MODELS = ["fable-5","opus-5","opus-4-8","opus-4-7","sonnet-5"]`, matched against a dot-or-dash-normalised id (`normalizeApiID`) (c2bc5c2a83);
  - `wantsSummarizedThinking` → efforts `low/medium/high/xhigh/max`, and thinking is omitted.
  - The effort reaches the SDK as `lastUser.model.variant`.

---

## B. Advisor (137879b0ef)
- **Config:** `packages/core/src/v1/config/config.ts` adds `advisor?: string` ("eg opus… 'off' or unset disables. Read from the global config only").
- **Live save:** `server/routes/instance/httpapi/handlers/global.ts`:
  - `LIVE_GLOBAL_KEYS = new Set(["advisor"])` (~18);
  - `configUpdate` (~94) skips `disposeAllInstancesAndEmitGlobalDisposed` when every payload key is live. Reason: the full restart reset the TUI session list and blanked cross-directory sessions.
- **Per turn:** `prompt.ts` reads `config.getGlobal().advisor` each turn and passes `advisorModel`, which `claude-sdk-query.ts` sends as `settings.advisorModel`. The CLI silently skips it when the account is ineligible or the advisor is weaker than the main model.
- **Rendering:**
  - The adapter maps a `server_tool_use name:"advisor"` block to a running `advisor` ToolPart.
  - `completeAdvisorCalls()` in the processor completes the part from `advisor_tool_result`, and must run **before** `finalizeRunningTools`.
  - Result content:
    - `advisor_result` text → output;
    - `advisor_redacted_result` → an explanatory note;
    - `advisor_tool_result_error` → "Advisor unavailable (code)".
- **TUI:** `packages/tui/src/component/dialog-advisor.tsx`.
  - Options: Off, Fable ("Strongest reviewer"), Opus, Sonnet.
  - Reads `sdk.client.global.config.get()`, which is the live value, and writes with `global.config.update({config:{advisor}})`.
- **Wiring:** `app.tsx` command `advisor.list` ("Switch advisor model", category Agent, `slashName: "advisor"`).
- **Tests:** advisor cases in `test/claude-sdk/message-map.test.ts`.

## C. Agents: build / yolo / assistant (plan removed)
- **`agent/agent.ts` (~142–186):**
  - `build`: defaults + `question allow, bash ask, edit ask, write ask`. It now asks explicitly (62afecf4ec).
  - `yolo`: "Auto runs write, edit, and bash commands.", `"*": "allow"`.
  - `assistant`: `"*": "allow"` + `prompt: PROMPT_ASSISTANT`.
  - All three are primary and native.
  - Others (upstream): `general`/`explore` subagents; `compaction`/`title`/`summary` hidden.
  - Defaults still contain `plan_enter`/`plan_exit: "deny"`.
- **Sort (~325):** default first, then native agents in declaration order, then custom agents by name, so the switcher cycles build→yolo→assistant.
- **`agent/prompt/assistant.txt`:**
  - autonomous teammate;
  - use the Devin MCP wiki tools (`mcp__devin__list_wiki_repos`, `read_wiki_structure`, `read_wiki_contents`, `ask_wiki_question`) for Corner Health repos;
  - announce up front when they are missing (`mcp.devin.enabled`);
  - a 5-step double-check before answering.
- **`tool/plan.ts`:** the PlanExit question became Build/Yolo/"Stay in Plan" and switches to the selected agent. **`session/prompt/plan.txt`** gained an "Exiting Plan Mode — MUST call plan_exit" section. Both are now vestigial (see below).
- **`config/config.ts` (~555):** the `multiedit` tool flag maps to the `edit` permission. `permission/index.ts` `EDIT_TOOLS` (~230) includes `multiedit`.
- **Tests:** `test/agent/agent.test.ts` and `plan-mode-subagent-bypass.test.ts` were modified.

## D. claude.ai session mirroring / mobile bridge (4c821bdc86, 5effb44f1c, 3f0cb8387b, f6a6e59f12, 42e323b989, d196a2d52b)
**What it does:** the "Start remote session" command attaches an opencode session to claude.ai/code through the SDK's **alpha** `@anthropic-ai/claude-agent-sdk/bridge`. The session can then be watched and driven from the Claude mobile app. This works behind a local `ANTHROPIC_BASE_URL` proxy, which `claude remote-control` refuses to do.

**`session/claude-sdk-bridge.ts`**
- **OAuth token — `readOauthToken()` / `readCredentials()`:**
  - reads `~/.claude/.credentials.json`;
  - on macOS falls back to `security find-generic-password -s "Claude Code-credentials" -w`;
  - requires `claudeAiOauth.accessToken`, not expired, scope `user:sessions:claude_code`.
- **Session mapping:**
  - `bridge-sessions.json` in `Global.Path.state` maps sessionID → `{codeSessionID: cse_*, mark?: MessageID}`;
  - writes are serialized (`writeEntry`);
  - `mark` is the backfill high-water mark.
- **Module maps:** `attached` (live handles), `pendingPermissions` (control request id → resolver), `pendingQuestions` (session → answer handlers).
- **Exports:** `registerRemoteQuestion`, `getMirror`, `mirroredSessions`, `detachMirror(sessionID,{forget})`.
- **`attachMirror({sessionID,title,cwd,model})`:**
  - calls `createCodeSession(BASE_URL, token, title, 30s, ["opencode"], …, cwd, model)` and persists the result;
  - calls `fetchRemoteCredentials`. Only a structured rejection forgets the mapping; a transient `null` keeps it (42e323b989);
  - calls `attachBridgeSession({sessionId, ingressToken: worker_jwt, apiBaseUrl, epoch, onInboundMessage, onPermissionResponse, onInterrupt, onClose})`.
- **`onInboundMessage` (bound with `Instance.bind`):**
  - offers the text to pending question handlers first;
  - otherwise mints a `messageID`, records it in `remoteOrigin` (echo suppression, f6a6e59f12), and calls `SessionPrompt.prompt({agent: "yolo"})`, constant `REMOTE_AGENT`.
- **`onInterrupt`:** calls `SessionPrompt.cancel`.
- **`MirrorHandle`:** `write/user/result/state/askPermission/cancelPermission/flush/close`. Every call into the handle is wrapped in `safe()` so mirroring can never fail a local turn.
- **`backfill()`:**
  - replays text-only history after `mark`, with `historical: true` and a uuid (needed for echo suppression);
  - tool calls become "_[ran x, y]_";
  - skips the still-running assistant message.
- **Order:** `flush` → `result` → `state("idle")` → then `attached.set`, so a mid-turn attach isn't stomped back to idle.
- **Integration points:**
  - permissions and questions fan out (A3);
  - the processor resolves the mirror per message (A4);
  - `prompt.ts` calls `getMirror(...)?.user(lastUser.id)`.

**Routes**
- **`groups/session.ts`:**
  - `remoteControlList` GET `/session/remote-control`. It is declared **before** `get` so `/:sessionID` doesn't swallow it.
  - `remoteControl` POST `/session/:id/remote-control` returns the `cse_` id.
  - `remoteControlStop` POST `/session/:id/remote-control/stop` returns a boolean.
- **`handlers/session.ts`:**
  - `remoteControl` (~376): a default title becomes `basename(directory)`, because claude.ai can't rename. It runs inside `withSessionInstance` and `Instance.restore`.
  - `remoteControlStop` (~405) and `remoteControlList` (~413).
  - `remove` (~251) calls `detachMirror(id, {forget:true})`.
- **`server/shared/workspace-routing.ts`:** `getWorkspaceRouteSessionID` excludes `/session/remote-control`.

**TUI**
- **`routes/session/index.tsx`:**
  - palette commands `session.remote` (slash `/remote`) and `session.remote.stop` (`/remote-stop`);
  - a `◉ remote` indicator in the prompt's `right` slot;
  - `remoteControlList` reconcile on session change (~1296).
- **`routes/home.tsx`:** reconciles on mount (~421) and shows `◉` next to the agent name.
- **`context/sync.tsx`:** `remote_sessions: string[]` (~124).

## E. MCP
**Global state — `mcp/index.ts`**
- `InstanceState` was removed. The state is a closure `State` with a new `reconnecting: Set`.
- Initialized from `cfgSvc.getGlobal()` (~621) at layer build.
- `currentDirectory` (~143) is `(yield* InstanceRef)?.directory ?? process.cwd()`.

**Reconnect**
- `setupReconnect` (~507) is called from init and from `storeClient`.
- `client.onerror` (~514) **closes** the client, so `onclose` fires. MCP SDK error paths don't trigger `onclose` on their own.
- `client.onclose` (~526):
  - deletes client, defs and instructions, sets status `failed`, publishes `ToolsChanged`;
  - `tryReconnect` retries with backoff `RECONNECT_DELAYS = [5s,10s,30s,60s,60s]` (~505), **forever** at the cap (a2dddc8e4a).
- `getMcpConfig` (~920): `(yield* InstanceRef) ? cfgSvc.get() : cfgSvc.getGlobal()`. A reconnect bridge has no instance, and `get()` defected silently.

**Connect / disconnect**
- `connect` (~767) stores the `{enabled:true}` override in `s.config` (c27ddf211a) and publishes `ToolsChanged` (19438590ad).
- `disconnect` (~778) stores `{enabled:false}`, closes the client and publishes `ToolsChanged`.
- `storeClient` returns `{status, changed}` using `toolsChanged()` (~687).

**Health route**
- `healthCheck` (~1106) pings each connected client with a 5s timeout and recreates the unresponsive ones, guarded by `reconnecting`.
- Exposed at `groups/mcp.ts` `health` POST `/mcp/health` (`mcp.health`) and `handlers/mcp.ts` `health`.
- The TUI calls `sdk.client.mcp.health()` after resume from SIGTSTP (`app.tsx` ~909).

**Toast fix:** `Effect.ignore` was replaced with `Effect.catchCause(() => Effect.void)` on publishes. Fix 11139ecf05: MCP toasts were poisoning the global AppRuntime.

**SDK def-cache invariants:** see A2.

**Test:** `test/mcp/reconnect.test.ts`.

## F. Server, session, core
- **`withSessionInstance` (handlers/session.ts ~78) and `withSessionInstanceOptional` (~86):**
  - `sessionInstance` (~75) is `session.get` → `store.load({directory})` → `Effect.provideService(InstanceRef, instance)`.
  - Wrapped handlers: abort (Optional), init, summarize, prompt, promptAsync, command, shell, deleteMessage, remoteControl.
  - `lastResponse` uses `sessionInstance` + `WithInstance.provide`.
  - `status` is deliberately unwrapped. Known gap: worktree agents' initial status is missing at bootstrap.
- **Haiku summaries:**
  - Route: `lastResponse` (~128), GET `/session/:id/last-response` → `{text, summary}`.
  - Text of 3 lines or fewer and 300 chars or fewer is returned raw.
  - Otherwise `Summarize.anthropic` (SDK `query()` with `claude-haiku-4-5-20251001`, `maxTurns 1`, `tools []`, 15s timeout) or `Summarize.aisdk` (`getSmallModel` + `generateText`).
  - Falls back to the truncated text.
  - The prompt-injection-safe template is in `session/summarize.ts`.
- **8 experimental routes:**
  - Groups in `groups/experimental.ts`; handlers in `handlers/experimental.ts` (`scanGitRepos`, `detectWorktree`, `gitOutput`).
  - GitHub routes call `github/index.ts`: `GitHub.status/pr/create/merge` over the `gh` CLI. `create` runs `git push -u origin <head>` first (via `util/git.ts`) and `summarize(stderr)`. `deriveChecks` reduces status checks to pass/fail/pending/none.
- **Cross-directory event bridge — `handlers/event.ts` (~66–84):**
  - The `cross` stream listens on `GlobalBus` for events whose `directory !== instance.directory`.
  - It skips `sync` and `server.instance.disposed`.
  - It is merged into the SSE stream.
  - `bus/global.ts` itself is **unchanged** vs upstream; UPSTREAM-SYNC.md is misleading here.
- **`permission/index.ts`:**
  - module `globalPending` (~32);
  - per-instance `ownedPending` (~38) for the finalizer;
  - each `PendingEntry.approved` is captured at `ask()`;
  - `reply`/`list` read global state;
  - the "denied" log line adds detail;
  - `evaluate` uses `findLast` (~45), so the **last** match wins.
  - `merge()` itself is unchanged.
- **`question/index.ts`:** module `index` (~46). `reply`/`reject`/`list` read it; it resolves the deferred before publishing.
- **Subagent seeding — `tool/task.ts` (~136, ~165):**
  - `caller = agent.get(ctx.agent)`;
  - child ruleset order is `[...caller.permission, ...childPermission, ...childToolDenies]`;
  - order is load-bearing.
- **`worktree/index.ts`:**
  - `candidate` (~184): `branch = input.detached ? undefined : name`, with no `opencode/` prefix;
  - `makeWorktreeInfo` (~210–214): root is `dirname(ctx.worktree)`, name is `<basename>-<slug>`, so worktrees are siblings of the source repo.
- **`cli/upgrade.ts`:** `upgrade()` is a no-op ("Dispatch is a fork").
- **`cli/cmd/tui.ts`:**
  - `--standalone` flag (~108) goes into `args.standalone`;
  - the `finally` block lazily imports `@opencode-ai/tui/context/kv` and `await`s `flushKV()` (~308) (973669ba5e);
  - the import is lazy to avoid pulling JSX into other CLI commands.
- **`command/index.ts`:**
  - `Default.DEEP_REVIEW="deepReview"`, `MERGE="merge"`;
  - templates `command/template/deep-review.txt` (multi-agent review for bugs and CLAUDE.md/AGENTS.md compliance) and `merge.txt` (rebase-and-merge the worktree branch into its detected parent);
  - both use `$ARGUMENTS` (be078ead67);
  - `hints()` extracts `$1…`/`$ARGUMENTS`.
- **Activity status:**
  - `session/processor.ts` `formatActivity()` (~31);
  - on a tool call: `status.set({busy, activity: "Bash pwd"})` (~355);
  - on `step-start`: `activity: "Thinking..."` (~448);
  - schema: `packages/schema/src/session-status-event.ts` busy variant `activity: optional(String)`;
  - `session/status.ts` comment pointer.
- **`session/revert.ts` (~72):**
  - `assertNotBusy`, snapshot and revert run only when `patches.length > 0`;
  - so a queued message can be reverted while the agent keeps running.
  - The TUI half of this is broken (see "lost or broken in the tree").
- **`session/system.ts` (~55, ~133):** `worktree(dir)` detection plus the "# Worktree Agent Context" block (merge rules, doc upkeep). Not a must-preserve: it only reaches the AI SDK path.
- **`config/config.ts`:** `installDependencies(dir)` service method (installs `@opencode-ai/plugin`); `multiedit` maps to `edit`.
- **`packages/plugin/src/tui.ts`:** `TuiState.home.selectedSessionID()` and `TuiState.agent.{current,list,set}`. They are implemented in `packages/tui/src/plugin/adapters.tsx` `stateApi(sync, local)`, which also maps the `diffview` route.
- **`packages/script/src/index.ts`:** the branch-name channel is sanitized (`[^a-zA-Z0-9.-]` → `-`); the version lookup uses `registry.npmjs.org/dispatch-tui/latest`.
- **`modules.d.ts`:** `declare module "sherpa-onnx-node"` for the opencode typecheck of the TUI sources.

## G. TUI (`packages/tui/src`)
### Agent dashboard — `routes/home.tsx`
- **Data:**
  - `AgentEntry` (~59): `{id, name, sessionID, createdAt, directory?, worktree?{branch,directory,sourceRepo}, summary?}`;
  - persisted in KV key `agents`;
  - `resolveDir` (~241) groups agents by directory and shows a diffstat per group.
- **Cursor:**
  - `lastEnteredSessionID` restores the cursor when returning (d856508efe);
  - `home_selected_session` (~460) publishes the cursor for plugins.
- **Status column:** "Approve (y/n)" / "Waiting for user" / "Working" spinner / "Retrying". Pending state recurses into child sessions (`children` map, `hasPending`, `hasPermission`, `approval`).
- **Detail rows:** the activity column shows `status.activity`. Below the row:
  - `PermissionDetail`: bash command or edit diff from `metadata.input/diff/filepath`;
  - or the agent summary when `agent_summaries_visible`.
- **Actions:**

  | Function | Line | Behaviour |
  |---|---|---|
  | `add()` | ~527 | DialogDirectorySelect → name → `session.create({directory, title: name})` (8e9add7cb5) → `worktree.info` → `insertAgent` |
  | `wt()` | ~553 | DialogGitRepoSelect → name → `worktree.create({directory: repo, worktreeCreateInput:{name}})` → pre-seeds a zero diffstat and `pending` branch→dir → `session.create({title})` |
  | `remove()` | ~589 | removes the agent from the dashboard |
  | `purge()` | ~604 | `worktree.remove` and drops every agent in that directory |
  | `diff()` | ~642 | navigates to the diffview |
  | `approve()`/`deny()` | ~649/657 | `permission.reply({once|reject})` |
  | `attach()` | ~689 | PTY terminal |
  | `propose()` | ~716 | create PR (title and body dialogs, POST `/github/pr`) |
  | `merge()` | ~783 | guards on OPEN, CI not failing and no changes requested; confirm; POST `/github/pr/merge` with the worktree `cwd` (ee9d546337) |
  | `link()` | ~764 | copy the PR url |
  | `refresh()` | ~710 | refetch PRs and diffstats |
  | `openPrompt()` | ~777 | `i` inline prompt |

- **Diffstat refresh:**
  - `fetchDiffStats` (~334) calls `sdk.client.worktree.diffstat({directory})` for each group not in `pending`;
  - the `worktree.ready` event (~356) clears `pending` by branch and refetches.
- **GitHub polling:**
  - `ghFetch` (~366) is raw `sdk.fetch` to `/experimental…` with `?directory=` appended;
  - KV keys `gh_status`, `pr_data`;
  - polling every 300s.
- **Inline prompt overlay:** `<Prompt sessionID directory={resolveDir} compact onSubmit>`. `compact` hides the busy/interrupt and footer UI.
- **Keyboard (~822):**

  | Key | Action |
  |---|---|
  | `j`/`k`/↑/↓ | navigate |
  | `1`–`9`, `0`, `!@#$%^&*()` | jump to agent (`hotkey`/`jump`) |
  | enter | open |
  | `c` | copy path |
  | `a` | new agent |
  | `w` | new worktree agent |
  | `d` | remove |
  | `x` | delete worktree |
  | `D` (shift+d) | diffview |
  | `y` / `n` | approve / deny |
  | `t` | terminal |
  | `i` | message |
  | `r` | refresh |
  | `P` | create PR (gh only) |
  | `o` | copy PR url |
  | `M` | merge PR (gh only) |

  - Keys are disabled while a dialog, the prompt or a leader sequence is active.
  - `useBindings` registers `app.exit`.
  - The footer hints list all keys (957150184c).
- **PTY attach — `util/pty.ts` `PtyAttach.open(id, cwd, renderer, {leader,label,dir,fg,bg})` and `cleanup()`:**
  - uses `bun-pty`, the login shell, `TERM=xterm-256color`, `OPENCODE_TERMINAL=1`;
  - keeps a 256KB replay buffer and a scroll region of rows−1 with a status bar on the last row;
  - strips DECSTBM resets (`/\x1b\[0*;?0*r/g`) from both the replay and the live pipe (ad869b02d4, 814b787978);
  - detaches on **leader then bare Esc**, with a 2s timeout that forwards the leader byte; a double leader sends one.
  - The label is `${leaderDisplay(cfg)} esc` (05a876d167; `keymap.tsx` exports `leaderDisplay`).
  - `leaderByte()` derives the control byte.
  - `app.tsx` adds a finalizer for `PtyAttach.cleanup`.
- **Worktree deletion guard (91c54db376) — `context/sync.tsx` (~204):** `server.instance.disposed` only re-bootstraps when `directory === project.data.instance.path.directory`, and `bootstrap()` clears `fullSyncedSessions`.
- **Session list scoping (e456f5f758):**
  - `sync.session.query(overrideDirectory)` returns `{directory}`, plus `scope:"project"` when unfiltered;
  - `component/dialog-session-list.tsx` `contextDirectory` resolves from the current or highlighted session → `sync.session.get().directory` → `AgentEntry.worktree.directory` → `directory`;
  - `onSelect` rewrites the KV agent's `sessionID` (164098f0d9).
- **KV — `context/kv.tsx`:**
  - `set` accepts a function updater (ef744d592a);
  - **read-merge-write** of only the changed key under `Flock` (0ba5a0f805). `kv.json` is shared across processes, and whole-store snapshots clobbered other processes' keys;
  - module `_pendingWrite` + `flushKV()`.

### Other routes and components
- **`routes/diffview.tsx`:**
  - route type `DiffviewRoute {type:"diffview", directory}` in `context/route.tsx`, rendered in `app.tsx` `<Match>`;
  - calls `sdk.client.worktree.diff({directory})` behind an `as any` guard;
  - splits the diff per file into `<diff>` components, split view when width > 120;
  - keys: esc/q back, j/k scroll, page up/down via `keybinds.gather("diffview", ["session.page.up","session.page.down"])`.
- **Draft restore:**
  - `draft.ts`: `shouldSave`, `resolve(seeded, hasInitial, hasDraft)`, `shouldBlock(restored)`;
  - `routes/session/index.tsx`: module `drafts` Map (~91), `boundSessionID` (~355), `bind()` (~356–379) saves on unmount and restores with `r.set(draft, true)`;
  - the `session.dashboard` command (~411) saves the draft under `boundSessionID ?? route.sessionID` and navigates home; it is disabled in standalone mode;
  - `onSubmit` deletes the draft;
  - `component/prompt/index.tsx`: `PromptRef.set(prompt, block)` sets `restored`; `submit` calls `shouldBlockSubmit` (~979); the upstream module-level `stashed` is **removed**.
- **Queued messages and undo:**
  - prompt double-interrupt (~421): snapshots a single queued message's text and files, aborts, then restores them into the input (f3cd056505, 030bc9648a);
  - session `UserMessage` shows `QUEUED` or an `UNSENT` badge (orphaned: idle, after the last assistant message);
  - `session.undo` (leader+u, `config/keybind.ts` ~148) is meant to abort only when the message isn't queued (a0a270226d). The guard is dead code — see "lost or broken in the tree".
- **Autocomplete — `component/prompt/autocomplete.tsx`:**
  - `directory` prop and the `resolvedLocation` memo (~105), used by `normalizeMentionPath` and `fs.find`;
  - slash commands come from `sync.command.for(props.directory)`.
- **Directory plumbing:**
  - the Prompt gets `directory` and `promptDirectory`;
  - session/index.tsx passes `directory={sync.session.get(...).directory}` to the permission (~1447), question (~1453) and main (~1478) prompts;
  - `sync.command.for(directory)` (sync.tsx ~703) lazily fetches `command.list({directory})` per directory (51c2bcee5a).
- **Tool rendering in `routes/session/index.tsx`:**
  - `ToolPart` lowercases the tool name and camelCases input keys;
  - `agent` maps to `task`, `code` to `codesearch`;
  - the `CodeSearch` renderer is kept;
  - `Write` renders `metadata.diff`;
  - child-session hint covers `agent` tools;
  - `message.part.updated` comes through `sdk.event.on`.
  - Close-child-session command `app.exit`.
- **`routes/session/permission.tsx`:**
  - input falls back to `metadata.input`;
  - `· subagent` tag when `metadata.agentID`;
  - `reject` **always** goes to the reason stage (~424).
- **`component/agent-summaries.tsx`:** mounted globally in `app.tsx`.
  - On busy: clears the summary.
  - On idle (agents only): raw `sdk.fetch(/session/:id/last-response)` → sync `agent_summary` and KV `agents[].summary`.
  - Toggle command `app.toggle.agent_summaries` with KV `agent_summaries_visible`.
- **Pickers:**
  - `component/dialog-git-repo-select.tsx`: `(sdk.client as any).gitRepos.list({root})`;
  - `component/dialog-directory-select.tsx`: `find.files({type:"directory"})`, filters hidden directories, adds a "." option.
- **`component/dialog-model.tsx`:** description falls back to `options.sdkDescription`.
- **`context/event.ts`:** the no-filter comment ("No directory/workspace filtering here on purpose"); directory and workspace are passed as metadata.
- **`context/args.tsx`:** `standalone`.
- **`app.tsx`:**
  - with `--standalone` the initial route is a session, and an effect creates a session in `sync.path.directory` and navigates to it;
  - `session.dashboard` in the app binding commands;
  - prompt footer shows the dashboard hint except in standalone mode (bfd46a89bc).
- **`config/keybind.ts`:** `dashboard: keybind("<leader>d", …)` → `session.dashboard` (b7fa6a3c74, dd729df16d).
- **`feature-plugins/sidebar/context.tsx`:** token display prefers `tokens.total`.
- **`ui/dialog-prompt.tsx`:** see "vestigial".

### Jarvis voice plugin (b0efb6cf3d) — `feature-plugins/jarvis/*`, registered in `feature-plugins/builtins.ts`
- **`index.tsx`:**
  - wires STT, TTS and the command dispatcher;
  - chimes: `bip-bop-03` on heard (mic muted 550ms), `staplebops-05` on ready (350ms);
  - dashboard TTS on an agent's busy→idle transition: after 2s it speaks the KV summary, or "<name> is waiting for you";
  - in-session TTS speaks the last assistant text (2000 chars);
  - reads out `permission.asked`;
  - `stt.onInterrupt` ("jarvis" keyword) stops TTS;
  - `app_bottom` slot `VoiceIndicator`;
  - palette commands `jarvis.toggle` and `jarvis.help`.
- **`stt.ts`:**
  - `sherpa-onnx-node` offline Parakeet TDT 0.6B int8, Silero VAD, and a zipformer KWS spotter;
  - models are downloaded from `github.com/k2-fsa/sherpa-onnx/releases` into `~/.jarvis/models`;
  - mic capture uses `ffmpeg` (avfoundation `:default` on macOS, pulse elsewhere) at s16le 16kHz mono. ffmpeg replaced node-cpal because it sees Bluetooth inputs.
- **`tts.ts`:**
  - `kokoro-js` Kokoro-82M q8 runs as a `bun -e` sidecar with a JSON-lines protocol;
  - env `JARVIS_VOICE` (default `af_heart`), `JARVIS_TTS_SPEED` (1.25);
  - playback with `afplay`/`aplay`; fallback `say`/`espeak`.
- **`commands.ts`:**
  - regex commands after the wake word "Jarvis": navigate/open, home, `message <agent>, <text>`, create agent or worktree (named or nameless), set-agent (build/yolo/assistant, plus mishear aliases), which-agent, summarize-last, read-last, off;
  - fuzzy name and repo matching (Levenshtein);
  - unmatched text is sent as a prompt with `system: VOICE_MODE_SYSTEM_PROMPT` (`voice-prompt.ts`);
  - bare utterances (no wake word) answer permissions: approve/yes/ok → once, always → always, deny [reason] → reject with message; otherwise it asks "Why are you denying this?";
  - uses `api.state.agent.*`, `api.kv.get("agents")` and `api.client.session/worktree/permission`.
- **`voice-state.ts`:** mode and status signals, `waitForResponse`. Also `help.tsx`, `indicator.tsx`, `modules.d.ts`.
- **Dependencies:** `packages/tui/package.json` adds `bun-pty` 0.4.8, `kokoro-js` ^1.2.1, `sherpa-onnx-node` ^1.13.5. node-cpal was removed (8016064157).

## H. Packaging / CI
- **`packages/opencode/package.json`:**
  - `name: "dispatch-tui"`, `version 1.4.6`, no longer `private`;
  - `bin: {"dispatch": "./bin/dispatch"}`;
  - **devDependencies** `@anthropic-ai/claude-agent-sdk 0.3.280` (bumped from 0.2.89 → 0.3.146 → 0.3.206 → 0.3.280) and `@anthropic-ai/sdk 0.74.0`.
  - `packages/web/package.json` dev-depends on `dispatch-tui`.
- **`packages/opencode/bin/dispatch` (new):** node launcher. Honours `OPENCODE_BIN_PATH`, then the cached `bin/.dispatch`, then the `dispatch-tui-<platform>-<arch>` package (AVX2 handling).
- **`install`:** `APP=dispatch-tui`; downloads from `github.com/achin90/Dispatch/releases` into `~/.dispatch/bin`; flags `--version`, `--binary`, `--no-modify-path` (1e5a04a02e).
- **`install-from-source`:** requires bun; `bun install` + `build.ts --single` into `~/.dispatch/bin`.
- **Workflows:**
  - `.github/workflows/*` repo guard `if: github.repository == 'anomalyco/opencode'` on beta, close-issues, compliance-close, nix-eval, opencode, pr-management, pr-standards, storybook, test, typecheck (c12e4df16a);
  - new `release.yml` (workflow_dispatch `version`): draft release → `build.ts` with `OPENCODE_VERSION/RELEASE` → upload `dispatch-cli` → publish.
- **`bunfig.toml`:** `minimumReleaseAgeExcludes` gains the claude-agent-sdk package and all its platform packages.
- **`.gitignore` / `packages/opencode/.gitignore`:** `models-snapshot.js/.d.ts`, `.env`.
- **Docs:** `README.md` (Dispatch branding, video, hotkeys), `UPSTREAM-SYNC.md`, `CLAUDE-SDK-MIGRATION.md`, `PHASE-0-PLAN.md`, `packages/opencode/AGENTS.md`, `test/AGENTS.md`.
- **Regenerated `packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts`:** `worktree.info/diff/diffstat`, `gitRepos.list`, `github.status/pr/createPr/mergePr`, `mcp.health`, `session.remoteControlList/remoteControl/remoteControlStop/lastResponse` (d52ee24401).

---

## Lookup tables

### HTTP routes added by Dispatch

| Group.endpoint | Method + path | Directory input | Handler |
|---|---|---|---|
| experimental.gitRepos | GET `/experimental/git-repos` | `GitReposQuery {root, query}` | `scanGitRepos` (skips hidden, symlinks, node_modules; stops at repo roots) |
| experimental.githubStatus | GET `/experimental/github/status` | none | `gh auth status` |
| experimental.githubPr | GET `/experimental/github/pr` | `GitHubPrQuery {branch, cwd}` | `GitHub.pr` |
| experimental.githubPrCreate | POST `/experimental/github/pr` | payload `{head, base?, title, body?, cwd}` | `GitHub.create` |
| experimental.githubPrMerge | POST `/experimental/github/pr/merge` | payload `{number, cwd?}` | `gh pr merge --merge` |
| experimental.worktreeInfo / worktreeDiff / worktreeDiffstat | GET `/experimental/worktree/{info,diff,diffstat}` | **`WorkspaceRoutingQuery`** | `detectWorktree`; `git diff HEAD`; `git diff HEAD --numstat` |
| mcp.health | POST `/mcp/health` | — | `MCP.healthCheck` |
| session.lastResponse | GET `/session/:id/last-response` | — | Haiku or small-model summary |
| session.remoteControlList / remoteControl / remoteControlStop | GET `/session/remote-control`; POST `/session/:id/remote-control[/stop]` | `WorkspaceRoutingQuery` | claude-sdk-bridge |

### TUI → server calls that are Dispatch-specific
- **Generated client:**
  - `worktree.info/diff/diffstat({directory})`
  - `(sdk.client as any).gitRepos.list`
  - `session.remoteControl/remoteControlStop/remoteControlList`
  - `mcp.health`
  - `global.config.get/update` (advisor)
  - `command.list({directory})`
  - `session.create({directory, title})`
  - `worktree.create/remove`
- **Raw `sdk.fetch`** (no generated client; `?directory=` appended by hand):
  - `/experimental/github/status|pr|pr/merge` in home.tsx `ghFetch`
  - `/session/:id/last-response` in agent-summaries.tsx

### Config keys, env vars, state files
- **Config:** `advisor` (global only, live key).
- **Environment set on the spawned CLI:** `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, `ENABLE_TOOL_SEARCH=false`, `ANTHROPIC_API_KEY`.
- **Other env:** `JARVIS_VOICE`, `JARVIS_TTS_SPEED`, `OPENCODE_TERMINAL=1` (PTY), `OPENCODE_BIN_PATH` (launcher).
- **Files:**
  - `~/.local/state/opencode/sdk-sessions.json`
  - `~/.local/state/opencode/bridge-sessions.json`
  - `~/.claude/.credentials.json`, or the macOS Keychain service `Claude Code-credentials`
  - `~/.jarvis/models`
- **KV keys:** `agents`, `pr_data`, `gh_status`, `agent_summaries_visible`.
- **Sync store fields:** `agent_summary`, `home_selected_session`, `remote_sessions`.
- **CLI flag:** `--standalone`.

### Keybinds and commands
- `<leader>d` `session.dashboard`
- `<leader>u` undo (upstream binding; the queued-message behaviour is Dispatch's)
- Dashboard keys: see the table in section G
- Diffview: esc/q, j/k, page up/down
- PTY detach: leader + Esc
- Slash and palette: `/advisor`, `/remote`, `/remote-stop`, `/deepReview`, `/merge`, "Hide/Show agent summaries", `jarvis.toggle`, `jarvis.help`

### Runtime external tools
`gh`, `git`, `security` (macOS), `ffmpeg`, `afplay`/`aplay`, `say`/`espeak`, `bun` (Kokoro sidecar).

---

## Lost or broken in the current tree (intended Dispatch behaviour that a merge dropped or broke)
- **f068182817 editor repaint:** `packages/tui/src/editor.ts:50` does `clear()` before `resume()`, which is upstream's order. The fix was resume-then-clear.
- **9e88fe9ddb string/object permission merge:** `config/config.ts:45` `mergeConfigConcatArrays` has no `normalize()`, so a string rule (`"bash":"ask"`) is lost when the other config uses object form. `test/permission/next.test.ts` tests `Permission.fromConfig/merge`, not this function.
- **b1548fbf4c opencode small-model fallbacks** (`big-pickle`, `nemotron-3-super-free`): not in `provider.ts`.
- **d058c8f8e6:** the `info &&` guard before `experimental.compaction.autocontinue` (`compaction.ts` ~702) is gone.
- **a0a270226d undo of queued messages (TUI half):**
  - In `routes/session/index.tsx` (~741–753), `session.undo` still runs upstream's **unconditional** `if (status?.type !== "idle") abort(...)` *before* Dispatch's `if (!isQueued) { abort }` guard.
  - So leader+u still interrupts the running agent; the guard is dead code.
  - The server half (`revert.ts` deferring `assertNotBusy`) is intact.

## Vestigial or no-op code (don't port as-is)
- **Plan-agent leftovers:**
  - `prompt.ts` ~1412 `agent.name === "plan"` block;
  - `tool/plan.ts` PlanExitTool, still registered at `tool/registry.ts:107`;
  - `session/prompt/plan.txt`;
  - `session/reminders.ts` plan references;
  - `canUseTool`'s ExitPlanMode branch, which is only reachable in SDK plan permissionMode, and that mode is never set.
  - The plan agent itself was removed in 3c684dc9c5.
- **`command/index.ts`:** `.replace("${path}", ctx.worktree)` is a no-op; neither template contains `${path}`.
- **`ui/dialog-prompt.tsx`:** `mounted` is written and never read.
- **`context/kv.tsx`:** `const agents = x["agents"]` is unused.
- **`provider.ts` `sdkProvider()` comment:** says default "currently opus-4-8"; it actually resolves to `claude-opus-5-5[1m]`.

---

## I. Tests

**Dispatch test files and what each guards**
- **`packages/opencode/test/claude-sdk/`:**
  - `adapter.test.ts` — `normalizeTool`, `snakeToCamel`, `normalizeInput` omit lists.
  - `auth.test.ts` — `resolveApiKey` precedence (env over Auth store; api type only).
  - `error-extraction.test.ts` — `extractErrorMessage` 5xx handling.
  - `helpers.ts` + `helpers.test.ts` — SDK message factories and scenarios.
  - `instance-boundary.test.ts` — **ALS boundary.** AppRuntime resolves the instance from ALS alone, readable at both `Instance.restore` sites. Verified to fail if a restore or the ALS-preferring `attach()` is removed. Omitted from UPSTREAM-SYNC's list; it is the guard for the most dangerous regression.
  - `integration.test.ts` and `manual-test.ts` — live API, end to end.
  - `message-map.test.ts` — block→part mapping, reasoning window, advisor call/result/redacted/error, result metadata.
  - `pending-meta.test.ts` — `popPendingMeta` pop semantics.
  - `permission.test.ts` — `extractPatterns`, `derivePermissionName`, `trimDiff`, and the `canUseTool` once/always/reject/abort and **cross-directory reply** cases.
  - `session-loop.test.ts` — `processClaudeSdkStream` parts, tokens, abort, subagent routing (child sessions, `sessionId` metadata, `task_started`/`task_notification`, multiple subagents, abort finalizes children).
  - `session-map.test.ts` — map persistence.
  - `token-counting.test.ts` — tokens come from result totals; `total` is the last turn's usage; no accumulation.
- **`test/command/dispatch-commands.test.ts`:** `DEEP_REVIEW`/`MERGE` constants and `hints()` with `$ARGUMENTS`.
- **`test/mcp/reconnect.test.ts`:** a globally configured server reconnects after a drop when `Config.get()` defects.
- **`test/permission/subagent-hook.test.ts`:**
  - forces `run_in_background:false` and preserves other input;
  - main-thread passthrough;
  - yolo parent allows all;
  - build parent yields ask (or allow for read);
  - an explicit deny wins under yolo.
- **`test/provider/sdk-models.test.ts`:** aliases, default resolves to Opus 1M, every 1M Opus entry has `[1m]`, Sonnet is native 1M, Haiku has no reasoning, `buildSdkModel` fields.
- **Server tests:**
  - `test/server/event-cross-directory.test.ts` — GlobalBus bridge, directory and workspace metadata, duplicate prevention.
  - `test/server/git-repos.test.ts` — the git-repos route.
  - `test/server/session-creation-directory.test.ts` — sessions keep their creation directory across instances.
  - `test/server/session-directory.test.ts` — shell runs in the session's directory; abort succeeds for a session owned by another directory.
- **`test/session/format-activity.test.ts`:** both `formatActivity` implementations.
- **`packages/tui/test/cli/tui/draft.test.ts`:** `shouldSave`/`resolve`/`shouldBlock` and the permission-dialog and dashboard cycles.

**Upstream tests Dispatch modified (they encode fork behaviour)**
- `test/agent/agent.test.ts` and `plan-mode-subagent-bypass.test.ts` — agent set and ordering, plan removal.
- `test/permission/next.test.ts` — appended `fromConfig + merge` mixed-form tests.
- `test/provider/provider.test.ts`, `test/provider/transform.test.ts` ("opus 5 returns adaptive thinking options with xhigh").
- `test/question/question.test.ts` — global index.
- `test/project/worktree.test.ts` — sibling path, no prefix.
- `test/tool/task.test.ts` — caller seeding.
- `test/server/httpapi-experimental.test.ts`, `test/server/httpapi-mcp-oauth.test.ts`.
- `test/cli/run/run-process.test.ts`, `test/tool/read.test.ts`, `test/session/prompt.test.ts`, `test/session/snapshot-tool-race.test.ts`.
- `test/fixture/config.ts`, `test/fixture/tui-plugin.ts` — the new `TuiState` fields.
- `packages/tui/test/cli/tui/use-event.test.tsx` — "delivers events from other directories when no workspace is active".