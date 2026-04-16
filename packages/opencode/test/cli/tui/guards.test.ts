import { describe, expect, test } from "bun:test"
import { shouldSkipKeyboard, shouldProcessEscape, shouldHandleEscape } from "../../../src/cli/cmd/tui/guards"

// ---------------------------------------------------------------------------
// Keybind guards — Dispatch regression guard
//
// These guards prevent dashboard keybinds from firing when:
// 1. A dialog (command palette, file picker) is open
// 2. Leader mode is active (leader+escape navigates to dashboard)
//
// Without these guards, pressing escape while a dialog is open dismisses
// the permission prompt instead of the dialog, and leader+escape rejects
// the permission instead of navigating.
// ---------------------------------------------------------------------------

describe("shouldSkipKeyboard", () => {
  test("skips when dialog stack is non-empty", () => {
    expect(shouldSkipKeyboard(1)).toBe(true)
    expect(shouldSkipKeyboard(3)).toBe(true)
  })

  test("does not skip when dialog stack is empty", () => {
    expect(shouldSkipKeyboard(0)).toBe(false)
  })
})

describe("shouldProcessEscape", () => {
  test("processes escape when not in leader mode", () => {
    expect(shouldProcessEscape(false, "escape")).toBe(true)
  })

  test("blocks escape when in leader mode", () => {
    expect(shouldProcessEscape(true, "escape")).toBe(false)
  })

  test("does not process non-escape keys", () => {
    expect(shouldProcessEscape(false, "return")).toBe(false)
    expect(shouldProcessEscape(false, "a")).toBe(false)
    expect(shouldProcessEscape(false, "tab")).toBe(false)
  })

  test("blocks all keys in leader mode", () => {
    expect(shouldProcessEscape(true, "return")).toBe(false)
    expect(shouldProcessEscape(true, "a")).toBe(false)
  })
})

describe("shouldHandleEscape", () => {
  test("handles escape with no dialog and no leader", () => {
    expect(shouldHandleEscape(false, "escape", 0)).toBe(true)
  })

  test("blocks when dialog is open regardless of leader", () => {
    expect(shouldHandleEscape(false, "escape", 1)).toBe(false)
    expect(shouldHandleEscape(true, "escape", 1)).toBe(false)
  })

  test("blocks when leader is active regardless of dialog", () => {
    expect(shouldHandleEscape(true, "escape", 0)).toBe(false)
  })

  test("blocks non-escape keys even with no dialog and no leader", () => {
    expect(shouldHandleEscape(false, "return", 0)).toBe(false)
  })

  // Regression scenario: leader+escape should navigate to dashboard, not dismiss prompt
  test("leader+escape does not dismiss permission prompt", () => {
    expect(shouldHandleEscape(true, "escape", 0)).toBe(false)
  })

  // Regression scenario: escape with command palette open should close palette, not prompt
  test("escape with dialog open does not dismiss permission prompt", () => {
    expect(shouldHandleEscape(false, "escape", 1)).toBe(false)
  })
})
