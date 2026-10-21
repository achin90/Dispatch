import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode/core/session/message"
import { BridgeBackfill } from "../../src/bridge/backfill"

const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

const user = (key: string, text: string) => ({ id: id(key), type: "user", text }) as unknown as SessionMessage.Info

const assistant = (key: string, content: unknown[], completed = true) =>
  ({
    id: id(key),
    type: "assistant",
    content,
    time: { created: 0, ...(completed ? { completed: 1 } : {}) },
  }) as unknown as SessionMessage.Info

describe("BridgeBackfill.select", () => {
  test("replays text and reduces tool calls to a note", () => {
    const result = BridgeBackfill.select([
      user("a", "list the files"),
      assistant("b", [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "Here they are." },
        { type: "tool", name: "shell" },
        { type: "tool", name: "read" },
      ]),
    ])
    expect(result.entries).toEqual([
      { id: id("a"), role: "user", text: "list the files" },
      { id: id("b"), role: "assistant", text: "Here they are.\n\n_[ran shell, read]_" },
    ])
    expect(result.mark).toEqual(id("b"))
  })

  test("starts after the mark by position, not by ID order", () => {
    // A queued prompt is admitted (and gets its ID) before the reply it follows in history.
    const result = BridgeBackfill.select(
      [user("1", "first"), assistant("3", [{ type: "text", text: "reply" }]), user("2", "queued")],
      id("3"),
    )
    expect(result.entries.map((entry) => entry.text)).toEqual(["queued"])
    expect(result.mark).toEqual(id("2"))
  })

  test("skips the assistant message still streaming", () => {
    const result = BridgeBackfill.select([
      user("a", "go"),
      assistant("b", [{ type: "text", text: "partial" }], false),
    ])
    expect(result.entries.map((entry) => entry.id)).toEqual([id("a")])
    expect(result.mark).toEqual(id("a"))
  })

  test("a message with nothing to render advances the mark without an entry", () => {
    const result = BridgeBackfill.select([user("a", "go"), assistant("b", [{ type: "reasoning", text: "hm" }])], id("a"))
    expect(result.entries).toEqual([])
    expect(result.mark).toEqual(id("b"))
  })

  test("a mark missing from history falls back to ID order", () => {
    const result = BridgeBackfill.select([user("1", "old"), user("5", "new")], id("3"))
    expect(result.entries.map((entry) => entry.text)).toEqual(["new"])
  })
})
