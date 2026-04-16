import { describe, expect, test } from "bun:test"
import { shouldSave, resolve, shouldBlock } from "../../../src/cli/cmd/tui/draft"

// ---------------------------------------------------------------------------
// Draft save/restore — Dispatch regression guard
//
// Drafts must be saved when permission dialogs appear and restored when
// they dismiss. The auto-submit prevention must block the first Enter
// after a draft is restored (the Enter that navigated into the session).
//
// Known regressions:
// - Draft not saving when permission dialog appears (bind(undefined) path)
// - Draft auto-submitting on Enter after navigation from dashboard
// - Draft not restoring after permission dialog dismissal
// ---------------------------------------------------------------------------

describe("shouldSave", () => {
  test("saves when input has text", () => {
    expect(shouldSave({ input: "hello", parts: [] })).toBe(true)
  })

  test("saves when parts are non-empty", () => {
    expect(shouldSave({ input: "", parts: [{ type: "file" }] })).toBe(true)
  })

  test("saves when both input and parts exist", () => {
    expect(shouldSave({ input: "hi", parts: [{}] })).toBe(true)
  })

  test("does not save empty prompt", () => {
    expect(shouldSave({ input: "", parts: [] })).toBe(false)
  })
})

describe("resolve", () => {
  test("returns none when already seeded", () => {
    expect(resolve(true, true, true)).toEqual({ action: "none" })
    expect(resolve(true, false, true)).toEqual({ action: "none" })
    expect(resolve(true, true, false)).toEqual({ action: "none" })
  })

  test("initial prompt takes priority over draft", () => {
    const result = resolve(false, true, true)
    expect(result.action).toBe("initial")
    if (result.action !== "none") expect(result.block).toBe(true)
  })

  test("uses draft when no initial prompt", () => {
    const result = resolve(false, false, true)
    expect(result.action).toBe("draft")
    if (result.action !== "none") expect(result.block).toBe(true)
  })

  test("returns none when no initial prompt and no draft", () => {
    expect(resolve(false, false, false)).toEqual({ action: "none" })
  })

  // Regression: navigating from dashboard with initial prompt should block submit
  test("initial prompt blocks auto-submit", () => {
    const result = resolve(false, true, false)
    expect(result.action).toBe("initial")
    if (result.action !== "none") expect(result.block).toBe(true)
  })

  // Regression: restoring after permission dialog should block submit
  test("draft restore blocks auto-submit", () => {
    const result = resolve(false, false, true)
    expect(result.action).toBe("draft")
    if (result.action !== "none") expect(result.block).toBe(true)
  })
})

describe("shouldBlock", () => {
  test("blocks first submit after restore", () => {
    const result = shouldBlock(true)
    expect(result.block).toBe(true)
    expect(result.next).toBe(false)
  })

  test("allows submit when not restored", () => {
    const result = shouldBlock(false)
    expect(result.block).toBe(false)
    expect(result.next).toBe(false)
  })

  // Regression: simulates the full lifecycle
  test("lifecycle: restore → block first submit → allow second submit", () => {
    // 1. Draft restored, restored flag = true
    let restored = true

    // 2. First submit attempt — blocked
    const first = shouldBlock(restored)
    expect(first.block).toBe(true)
    restored = first.next // flag cleared

    // 3. Second submit attempt — allowed
    const second = shouldBlock(restored)
    expect(second.block).toBe(false)
  })

  // Regression: multiple rapid submits should not bypass the guard
  test("flag clears after first blocked submit", () => {
    const check = shouldBlock(true)
    expect(check.block).toBe(true)
    expect(check.next).toBe(false) // cleared

    // Subsequent check with cleared flag
    const next = shouldBlock(check.next)
    expect(next.block).toBe(false)
  })
})

describe("draft save/restore lifecycle", () => {
  test("permission dialog cycle: save → restore → block submit", () => {
    // 1. User is typing
    const typing = { input: "fix the bug", parts: [] }
    expect(shouldSave(typing)).toBe(true)

    // 2. Permission dialog appears, prompt unmounts, draft saved
    // (component saves to drafts map)

    // 3. Permission dialog dismissed, prompt remounts
    const resolution = resolve(false, false, true)
    expect(resolution.action).toBe("draft")
    if (resolution.action !== "none") expect(resolution.block).toBe(true)

    // 4. Draft restored with block=true, user presses Enter
    let restored = true
    const submit = shouldBlock(restored)
    expect(submit.block).toBe(true)
    restored = submit.next

    // 5. User types more and presses Enter again
    const submit2 = shouldBlock(restored)
    expect(submit2.block).toBe(false)
  })

  test("dashboard navigation cycle: save → navigate → return → restore", () => {
    // 1. User types in prompt
    const typing = { input: "analyze the code", parts: [] }
    expect(shouldSave(typing)).toBe(true)

    // 2. User presses dashboard keybind, draft saved

    // 3. User returns to session
    const resolution = resolve(false, false, true)
    expect(resolution.action).toBe("draft")
    if (resolution.action !== "none") expect(resolution.block).toBe(true)
  })

  test("empty prompt does not save on navigation", () => {
    const empty = { input: "", parts: [] }
    expect(shouldSave(empty)).toBe(false)
  })

  test("initial prompt from dashboard takes priority", () => {
    // User navigates from dashboard with an initial prompt AND there's a saved draft
    const resolution = resolve(false, true, true)
    expect(resolution.action).toBe("initial")
  })
})
