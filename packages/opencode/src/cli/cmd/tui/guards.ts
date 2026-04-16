/**
 * Pure guard functions for keybind and dialog interactions.
 *
 * These are extracted from inline TUI component logic so they can be
 * unit tested without Solid.js rendering. The TUI components delegate
 * to these functions for their guard decisions.
 *
 * Dispatch regression guard — these guards prevent dashboard keybinds
 * from firing when a dialog is open or when leader mode is active.
 */

/**
 * Returns true if keyboard events should be skipped entirely.
 * Used at the top of every useKeyboard handler in permission/question prompts.
 */
export function shouldSkipKeyboard(dialogStackLength: number): boolean {
  return dialogStackLength > 0
}

/**
 * Returns true if an escape/exit keypress should be processed.
 * Only fires when NOT in leader mode (leader+escape is used for dashboard nav).
 */
export function shouldProcessEscape(leader: boolean, name: string): boolean {
  if (leader) return false
  return name === "escape"
}

/**
 * Combined guard: should a keybind handler process this event at all?
 * Checks dialog stack first, then leader mode for escape keys.
 */
export function shouldHandleEscape(leader: boolean, name: string, dialogStackLength: number): boolean {
  if (shouldSkipKeyboard(dialogStackLength)) return false
  return shouldProcessEscape(leader, name)
}
