import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"

// ---------------------------------------------------------------------------
// Dispatch custom commands — regression guard
//
// /deepReview and /merge are Dispatch-only commands. Upstream only has
// /init and /review. These must survive merges.
// ---------------------------------------------------------------------------

describe("dispatch custom commands", () => {
  test("deepReview command constant is defined", () => {
    expect(Command.Default.DEEP_REVIEW).toBe("deepReview")
  })

  test("merge command constant is defined", () => {
    expect(Command.Default.MERGE).toBe("merge")
  })

  test("all default command constants exist", () => {
    const keys = Object.keys(Command.Default)
    expect(keys).toContain("INIT")
    expect(keys).toContain("REVIEW")
    expect(keys).toContain("DEEP_REVIEW")
    expect(keys).toContain("MERGE")
  })

  test("default constants have correct values", () => {
    expect(Command.Default.INIT).toBe("init")
    expect(Command.Default.REVIEW).toBe("review")
    expect(Command.Default.DEEP_REVIEW).toBe("deepReview")
    expect(Command.Default.MERGE).toBe("merge")
  })

  test("hints extracts numbered placeholders", () => {
    expect(Command.hints("Review $1 and $2")).toEqual(["$1", "$2"])
  })

  test("hints extracts $ARGUMENTS", () => {
    expect(Command.hints("Do $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("hints returns empty for no placeholders", () => {
    expect(Command.hints("Just a plain template")).toEqual([])
  })

  test("hints deduplicates repeated placeholders", () => {
    expect(Command.hints("$1 then $1 again")).toEqual(["$1"])
  })

  test("hints sorts numbered placeholders", () => {
    expect(Command.hints("$3 before $1 and $2")).toEqual(["$1", "$2", "$3"])
  })

  test("hints handles both numbered and $ARGUMENTS", () => {
    expect(Command.hints("$1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })
})
