export * as BridgeBackfill from "./backfill.js"

import type { SessionMessage } from "@opencode/core/session/message"

export interface Entry {
  readonly id: SessionMessage.ID
  readonly role: "user" | "assistant"
  readonly text: string
}

/**
 * The history to replay when a mirror attaches: the messages after `mark`, in order, reduced to
 * text. Tool calls become a one-line note; a faithful tool_use/tool_result replay would need block
 * ids the SDK never gave us. Returns the new high-water mark alongside.
 *
 * `messages` must be in history order. The mark is found by position, not by comparing IDs: a
 * prompt's ID is minted when it is admitted, so a queued prompt can sort before an assistant
 * message it follows in history.
 */
export function select(messages: ReadonlyArray<SessionMessage.Info>, mark?: SessionMessage.ID) {
  const index = mark ? messages.findIndex((message) => message.id === mark) : -1
  // A mark that is no longer in history (reverted) falls back to the ID order it approximates.
  const after =
    index >= 0 ? messages.slice(index + 1) : mark ? messages.filter((message) => message.id > mark) : messages
  return after.reduce<{ entries: Entry[]; mark: SessionMessage.ID | undefined }>(
    (state, message) => {
      // The live stream owns a message the model is still producing: a snapshot here would duplicate
      // or reorder what arrives next. Its head is lost remotely, the price of attaching mid-turn.
      if (message.type === "assistant" && message.time.completed === undefined) return state
      const entry = toEntry(message)
      // A message with nothing to render still advances the mark, so it is not re-examined later.
      return { entries: entry ? [...state.entries, entry] : state.entries, mark: message.id }
    },
    { entries: [], mark },
  )
}

function toEntry(message: SessionMessage.Info): Entry | undefined {
  if (message.type === "user")
    return message.text.trim() === "" ? undefined : { id: message.id, role: "user", text: message.text }
  if (message.type !== "assistant") return undefined
  const text = message.content
    .flatMap((part) => (part.type === "text" && part.text.trim() !== "" ? [part.text] : []))
    .join("\n\n")
  const tools = message.content.flatMap((part) => (part.type === "tool" ? [part.name] : []))
  const body = [text, tools.length > 0 ? `_[ran ${tools.join(", ")}]_` : ""].filter(Boolean).join("\n\n")
  return body ? { id: message.id, role: "assistant", text: body } : undefined
}
