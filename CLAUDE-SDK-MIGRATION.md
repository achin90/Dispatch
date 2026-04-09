# Claude Agent SDK Migration Plan

Migrate from Vercel AI SDK (`@ai-sdk/*`) to the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) while keeping the TUI experience identical. Authentication should use the existing Claude Code login on the machine (API key or subscription).

## Architecture Change

**Current**: `streamText()` from `ai` SDK as a low-level model interface — the app owns the tool loop, tool execution, permission checks, and message management.

**Target**: `query()` from the Claude Agent SDK as a high-level agent — it owns the tool loop, has built-in tools (Read, Write, Edit, Bash, Glob, Grep), and executes them autonomously. The app consumes output messages from an async generator.

## Phases

### Phase 0: Test Infrastructure Setup [COMPLETE]
Create test helpers for mocking Agent SDK responses (`SDKMessage` factories for `AssistantMessage`, `ResultMessage`, `SystemMessage`). These helpers are used by all subsequent phases.

- **Package**: `@anthropic-ai/claude-agent-sdk` v0.2.89 installed
- **Files**: `test/claude-sdk/helpers.ts`, `test/claude-sdk/helpers.test.ts`

### Phase 1: Message Format Mapping [COMPLETE]
Build a pure adapter that converts `SDKMessage` → `MessageV2` parts (TextPart, ToolPart, ReasoningPart). Stateless, no side effects.

- **Files**: `src/session/claude-sdk-adapter.ts`, `test/claude-sdk/message-map.test.ts`

### Phase 2: Permission Bridge [COMPLETE]
Build the `canUseTool` callback bridging Agent SDK permission requests to the existing `Permission.ask()` system.

- **Files**: `src/session/claude-sdk-permissions.ts`, `test/claude-sdk/permission.test.ts`

### Phase 3: Session Loop Rewrite [COMPLETE]
New processor that consumes Agent SDK's `query()` output and maps it into persisted MessageV2 parts.

- **Files**: `src/session/claude-sdk-processor.ts`, `test/claude-sdk/session-loop.test.ts`

### Phase 4: Auth Integration [COMPLETE]
Wire authentication so the Agent SDK uses existing Claude Code credentials.

- **Files**: `src/session/claude-sdk-query.ts`, `test/claude-sdk/auth.test.ts`

### Phase 5: Live Integration Test [COMPLETE]
End-to-end test with a real Claude API call through the full stack.

- **Files**: `test/claude-sdk/integration.test.ts`

### Phase 6: Provider Cleanup & Switchover [COMPLETE]
Wired the Claude Agent SDK into `SessionPrompt.loop()`. The normal processing section now branches: `model.providerID === "anthropic"` → Claude SDK path, all others → AI SDK path.

- **Files modified**: `src/session/prompt.ts`
- **Note**: Old ai-sdk code paths remain for non-Anthropic providers.

## What Stays the Same
- Entire TUI layer (routes, components, themes, keybindings, dialogs)
- Permission UI (permission dock, auto-accept, question dock)
- Sync/event system (SSE events, global-sync store, event-reducer)
- Message storage (MessageV2 tables, parts, session management)
- MCP integration (passed to Agent SDK's `mcpServers` option)
