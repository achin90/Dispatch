# Phase 0: Test Infrastructure Setup — Detailed Implementation Plan

## Goal
Create mock factories that produce valid Claude Agent SDK `SDKMessage` objects, plus a fake async generator to simulate `query()` responses. These helpers are used by all subsequent phases.

## Prerequisites
- Install `@anthropic-ai/claude-agent-sdk` as a dev dependency (for types only — no real subprocess in tests)
- Verify the package exposes the needed types: `SDKMessage`, `SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, etc.

## Step 1: Install the SDK package

```bash
cd packages/opencode && bun add -d @anthropic-ai/claude-agent-sdk
```

If the SDK doesn't export granular types, we define our own minimal type stubs matching the documented shapes. The mock factories must produce objects that are structurally compatible with what the real SDK emits.

**Checkpoint**: `bun add` succeeds. Import `{ query }` from the package compiles (or we confirm which types are exported and which we need to stub).

## Step 2: Create `test/claude-sdk/helpers.ts`

This file provides factory functions that produce mock SDK messages. Each factory uses sensible defaults but allows overrides for test-specific scenarios.

### 2a: ID generators

```typescript
function uuid(): string  // random UUID
function sessionId(): string  // random session ID
```

### 2b: Content block factories

These produce Anthropic API content blocks (the inner data of `AssistantMessage.message.content`):

| Factory | Produces | Key fields |
|---------|----------|------------|
| `textBlock(text, overrides?)` | `TextBlock` | `{ type: "text", text }` |
| `thinkingBlock(thinking, overrides?)` | `ThinkingBlock` | `{ type: "thinking", thinking }` |
| `toolUseBlock(name, input, overrides?)` | `ToolUseBlock` | `{ type: "tool_use", id, name, input }` |
| `toolResultBlock(toolUseId, content, overrides?)` | `ToolResultBlock` | `{ type: "tool_result", tool_use_id, content }` |

### 2c: Message factories

| Factory | Produces | Key fields |
|---------|----------|------------|
| `assistantMessage(content[], overrides?)` | `SDKAssistantMessage` | `{ type: "assistant", uuid, session_id, message: { content, model, stop_reason, usage }, parent_tool_use_id }` |
| `resultMessage(subtype, overrides?)` | `SDKResultMessage` | `{ type: "result", subtype, uuid, session_id, duration_ms, num_turns, total_cost_usd, usage, ... }` |
| `systemMessage(overrides?)` | `SDKSystemMessage` | `{ type: "system", subtype: "init", uuid, session_id, tools, model, ... }` |

### 2d: Sequence builder + fake query generator

```typescript
// Build a scripted sequence of messages
function messageSequence(...messages: SDKMessage[]): AsyncGenerator<SDKMessage, void>

// Pre-built common scenarios
function simpleTextResponse(text: string): AsyncGenerator<SDKMessage>
function toolCallResponse(toolName: string, input: object, result: string, finalText: string): AsyncGenerator<SDKMessage>
function thinkingThenTextResponse(thinking: string, text: string): AsyncGenerator<SDKMessage>
function errorResponse(errorSubtype: string, errors: string[]): AsyncGenerator<SDKMessage>
```

`messageSequence()` returns an async generator that yields each message in order — this simulates what `query()` returns without spawning a real subprocess.

**Checkpoint**: Each factory can be called and produces an object matching the expected type shape. TypeScript compilation passes.

## Step 3: Create `test/claude-sdk/helpers.test.ts`

Verify the helpers themselves are correct before other phases depend on them.

### Tests

| # | Test name | What it verifies |
|---|-----------|------------------|
| 1 | `textBlock produces valid TextBlock` | `type === "text"`, `text` field present |
| 2 | `thinkingBlock produces valid ThinkingBlock` | `type === "thinking"`, `thinking` field present |
| 3 | `toolUseBlock produces valid ToolUseBlock` | `type === "tool_use"`, `id` is string, `name` and `input` present |
| 4 | `toolResultBlock produces valid ToolResultBlock` | `type === "tool_result"`, `tool_use_id` matches, `content` present |
| 5 | `assistantMessage wraps content blocks` | `type === "assistant"`, `message.content` is the array passed in, `uuid` and `session_id` are strings |
| 6 | `assistantMessage allows overrides` | Override `session_id`, `parent_tool_use_id`, verify they stick |
| 7 | `resultMessage success` | `subtype === "success"`, has `result` field, `is_error === false` |
| 8 | `resultMessage error` | `subtype === "error_during_execution"`, has `errors` array, `is_error === true` |
| 9 | `systemMessage has init subtype` | `type === "system"`, `subtype === "init"`, `tools` is array |
| 10 | `messageSequence yields in order` | Collect all messages from async generator, verify count and order match input |
| 11 | `simpleTextResponse yields system → assistant → result` | 3 messages, types are `["system", "assistant", "result"]` |
| 12 | `toolCallResponse yields system → assistant(tool_use) → assistant(tool_result) → assistant(text) → result` | Correct message types and content block types in order |
| 13 | `thinkingThenTextResponse yields thinking block before text block` | Assistant message content has `[ThinkingBlock, TextBlock]` |
| 14 | `errorResponse yields result with is_error=true` | Result message has correct error subtype and errors array |

## File Structure After Phase 0

```
packages/opencode/test/claude-sdk/
├── helpers.ts       # Mock factories and sequence builders
└── helpers.test.ts  # Tests for the helpers themselves
```

## Acceptance Criteria

- [x] `@anthropic-ai/claude-agent-sdk` v0.2.81 installed — exports types from `sdk.d.ts`
- [x] All 22 helper tests pass via `bun test test/claude-sdk/helpers.test.ts` (22 pass, 0 fail)
- [x] Factories produce objects that match the SDK's actual type definitions (BetaMessage, BetaContentBlock, etc.)
- [x] `messageSequence()` returns a proper async generator that can be consumed with `for await`
- [x] No real subprocess is spawned — everything is in-memory mock data

## Notes

- The correct package is `@anthropic-ai/claude-agent-sdk` (not `@anthropic-ai/claude-code` which is the CLI binary)
- The SDK has some broken internal type references in `sdk.d.ts` (missing `SDKControlEndSessionRequest` etc.) but these don't affect our usage
- `NonNullableUsage` requires all `BetaUsage` fields to be non-null, so result messages use `defaultNonNullableUsage()` with concrete values
- `BetaUsage` (used in `BetaMessage.usage`) allows `null` fields, so assistant messages use `defaultBetaUsage()`
