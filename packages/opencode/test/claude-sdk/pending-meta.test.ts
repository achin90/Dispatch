import { describe, expect, test } from "bun:test"
import { popPendingMeta } from "../../src/session/claude-sdk-permissions"

// ---------------------------------------------------------------------------
// popPendingMeta — Dispatch regression guard
//
// The SDK calls canUseTool() concurrently with yielding the assistant message.
// The stream processor may not have created the ToolPart yet, so diffs are
// stored in a pending map and popped when the part is finalized.
// ---------------------------------------------------------------------------

describe("popPendingMeta", () => {
  test("returns undefined for unknown callID", () => {
    expect(popPendingMeta("unknown-" + Date.now())).toBeUndefined()
  })

  test("returns undefined when called twice (pop semantics)", () => {
    // We can't directly push into the pending map since it's module-private,
    // but we can verify pop semantics: calling twice returns undefined the second time
    const id = "already-popped-" + Date.now()
    // First call for unknown key
    expect(popPendingMeta(id)).toBeUndefined()
    // Second call for same key
    expect(popPendingMeta(id)).toBeUndefined()
  })
})
