/**
 * Pure draft save/restore decision logic.
 *
 * Extracted from session/index.tsx and prompt/index.tsx so the decision
 * logic can be unit tested without Solid.js rendering. The components
 * delegate to these functions.
 *
 * Dispatch regression guard — drafts must be saved when permission
 * dialogs appear and restored when they dismiss, without auto-submitting.
 */

export type DraftInfo = {
  input: string
  parts: unknown[]
}

/**
 * Whether the current prompt state should be saved as a draft.
 * True when the prompt has any content (text or attachments).
 */
export function shouldSave(info: DraftInfo): boolean {
  return !!(info.input || info.parts.length)
}

type Resolution =
  | { action: "initial"; block: true }
  | { action: "draft"; block: true }
  | { action: "none" }

/**
 * Determines what to restore when a prompt mounts.
 *
 * Priority:
 * 1. If already seeded, do nothing (prevents double-restore)
 * 2. If an explicit initialPrompt was passed (e.g. from dashboard), use it
 * 3. If a saved draft exists for this session, restore it
 * 4. Otherwise, start with an empty prompt
 *
 * Both restore paths set block=true to prevent auto-submit.
 */
export function resolve(
  seeded: boolean,
  hasInitial: boolean,
  hasDraft: boolean,
): Resolution {
  if (seeded) return { action: "none" }
  if (hasInitial) return { action: "initial", block: true }
  if (hasDraft) return { action: "draft", block: true }
  return { action: "none" }
}

/**
 * Whether a submit should be blocked because the prompt was just restored.
 *
 * When a draft is restored via ref.set(prompt, true), the Enter key that
 * navigated into the session can fire submit() before the user types.
 * This function returns true to block that first submit.
 *
 * Returns the new state of the restored flag after the check.
 */
export function shouldBlock(restored: boolean): { block: boolean; next: boolean } {
  if (restored) return { block: true, next: false }
  return { block: false, next: false }
}
