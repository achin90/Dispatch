# Claude Agent SDK Migration Plan

Migrate from Vercel AI SDK (`@ai-sdk/*`) to the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) while keeping the TUI experience identical. Authentication should use the existing Claude Code login on the machine (API key or subscription).

## Architecture Change

**Current**: `streamText()` from `ai` SDK as a low-level model interface — the app owns the tool loop, tool execution, permission checks, and message management.

**Target**: `query()` from the Claude Agent SDK as a high-level agent — it owns the tool loop, has built-in tools (Read, Write, Edit, Bash, Glob, Grep), and executes them autonomously. The app consumes output messages from an async generator.

## Phases

### Phase 0: Test Infrastructure Setup [COMPLETE]
Create test helpers for mocking Agent SDK responses (`SDKMessage` factories for `AssistantMessage`, `ResultMessage`, `SystemMessage`). These helpers are used by all subsequent phases.

- **Package**: `@anthropic-ai/claude-agent-sdk` v0.2.81 installed
- **Files**: `test/claude-sdk/helpers.ts`, `test/claude-sdk/helpers.test.ts`
- **Checkpoint**: 22/22 tests pass. Factories produce valid `SDKMessage` sequences matching the SDK's actual types.

### Phase 1: Message Format Mapping [COMPLETE]
Build a pure adapter that converts `SDKMessage` → `MessageV2` parts (TextPart, ToolPart, ReasoningPart). Stateless, no side effects.

- **Files**: `src/session/claude-sdk-adapter.ts`, `test/claude-sdk/message-map.test.ts`
- **Checkpoint**: 28/28 tests pass. All mappings verified:
  - `BetaTextBlock` → `MessageV2.TextPart`
  - `BetaToolUseBlock` → `MessageV2.ToolPart` (state=running, with callID, tool name, input)
  - `BetaThinkingBlock` → `MessageV2.ReasoningPart`
  - Unsupported blocks (redacted_thinking, etc.) → filtered out (null)
  - Mixed content → correct array of parts in order with unique IDs
  - `SDKResultMessage` success → `CompletionMetadata` with result, tokens, cost
  - `SDKResultMessage` error → `CompletionMetadata` with errors array
  - `SDKSystemMessage` → `InitMetadata` with model, tools, cwd, permission_mode

### Phase 2: Permission Bridge [COMPLETE]
Build the `canUseTool` callback bridging Agent SDK permission requests to the existing `Permission.ask()` system.

- **Files**: `src/session/claude-sdk-permissions.ts`, `test/claude-sdk/permission.test.ts`
- **Checkpoint**: 32/32 tests pass. Bridge verified:
  - `extractPatterns()` maps tool name + input to correct patterns (file_path, command, url, etc.)
  - `derivePermissionName()` maps SDK tool names to existing permission names
  - `createCanUseToolBridge()` publishes `Permission.Event.Asked` → TUI shows dock → user replies → returns `PermissionResult`
  - "once"/"always" reply → `{ behavior: "allow" }`
  - "reject" reply → `{ behavior: "deny", message }`
  - Pre-aborted signal → immediate deny
  - Signal abort during wait → deny
  - Wrong request IDs ignored
  - Tool metadata (toolName, title) included in request

### Phase 3: Session Loop Rewrite [COMPLETE]
New processor that consumes Agent SDK's `query()` output and maps it into persisted MessageV2 parts.

- **Files**: `src/session/claude-sdk-processor.ts`, `test/claude-sdk/session-loop.test.ts`
- **Checkpoint**: 11/11 tests pass (mocked `query()` with scripted sequences):
  - Simple text response → TextPart created, session completes with "stop"
  - Tool call → ToolPart with running state, correct tool name and input
  - Thinking + text → ReasoningPart then TextPart in order
  - Error result → error outcome, assistant message marked with error
  - error_max_turns → error outcome with correct errors array
  - Abort signal → stops cleanly, marks assistant with abort error
  - Multi-turn tool calls → multiple ToolParts in order
  - Result updates assistant tokens/cost metadata
  - Unsupported message types (auth_status, status) → ignored
  - Mixed content blocks (thinking + text + tool) in single message → 3 parts
  - Each part gets unique ID with correct session/message IDs

### Phase 4: Auth Integration [COMPLETE]
Wire authentication so the Agent SDK uses existing Claude Code credentials.

- **Files**: `src/session/claude-sdk-query.ts`, `test/claude-sdk/auth.test.ts`
- **Checkpoint**: 5/5 tests pass:
  - `ANTHROPIC_API_KEY` env var → returned directly
  - Auth store with `type: "api"` → key returned
  - No credentials → returns undefined (SDK falls back to OAuth/subscription)
  - OAuth auth entries → ignored (only `api` type used)
  - Env var takes precedence over Auth store

### Phase 5: Live Integration Test [COMPLETE]
End-to-end test with a real Claude API call through the full stack.

- **Files**: `test/claude-sdk/integration.test.ts`
- **Checkpoint**: Test skips when no API key (preload clears env vars). When run manually with `ANTHROPIC_API_KEY` set, verifies: `query()` → `processClaudeSdkStream()` → assistant message finalized with tokens/cost.

### Phase 6: Provider Cleanup & Switchover [COMPLETE]
Wired the Claude Agent SDK into `SessionPrompt.loop()`. The normal processing section now calls `createClaudeSdkQuery()` + `processClaudeSdkStream()` instead of `SessionProcessor.create().process()` + `LLM.stream()`.

- **Files modified**: `src/session/prompt.ts` (-134, +57 lines), `src/session/claude-sdk-query.ts` (+maxTurns)
- **Checkpoint**: All 104 claude-sdk tests pass. Manual end-to-end test works with subscription login.
- **Note**: Old ai-sdk code paths (`processor.ts`, `llm.ts`, `provider/`) are still in the codebase but no longer called from the main loop. They can be cleaned up in a follow-up.

## What Stays the Same
- Entire TUI layer (routes, components, themes, keybindings, dialogs)
- Permission UI (permission dock, auto-accept, question dock)
- Sync/event system (SSE events, global-sync store, event-reducer)
- Message storage (MessageV2 tables, parts, session management)
- MCP integration (passed to Agent SDK's `mcpServers` option)

## What Gets Removed (Phase 6)
- `packages/opencode/src/provider/provider.ts` — multi-provider registry
- `packages/opencode/src/provider/transform.ts` — provider-specific transforms
- `packages/opencode/src/provider/sdk/` — custom Copilot/OpenAI-compatible implementations
- `packages/opencode/src/provider/models.ts` — dynamic model discovery
- All `@ai-sdk/*` dependencies
