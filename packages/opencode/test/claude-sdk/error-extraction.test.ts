import { describe, expect, test } from "bun:test"
import { extractErrorMessage } from "../../src/session/claude-sdk-processor"

// ---------------------------------------------------------------------------
// extractErrorMessage — Dispatch regression guard
//
// Converts various error shapes from the Claude SDK into user-facing strings.
// Must handle Error instances, plain strings, HTTP status codes, and unknowns.
// ---------------------------------------------------------------------------

describe("extractErrorMessage", () => {
  test("returns message from Error instance", () => {
    expect(extractErrorMessage(new Error("something broke"))).toBe("something broke")
  })

  test("returns generic message for empty Error", () => {
    expect(extractErrorMessage(new Error(""))).toBe("Unknown error")
  })

  test("detects HTTP 500 from .status property", () => {
    const err = Object.assign(new Error("fail"), { status: 500 })
    expect(extractErrorMessage(err)).toBe("Claude internal server error")
  })

  test("detects HTTP 500 from .statusCode property", () => {
    const err = Object.assign(new Error("fail"), { statusCode: 500 })
    expect(extractErrorMessage(err)).toBe("Claude internal server error")
  })

  test("detects HTTP 500 as string", () => {
    const err = Object.assign(new Error("fail"), { status: "500" })
    expect(extractErrorMessage(err)).toBe("Claude internal server error")
  })

  test("detects other 5xx errors", () => {
    const err = Object.assign(new Error("fail"), { status: 502 })
    expect(extractErrorMessage(err)).toBe("Claude server error (502)")
  })

  test("does not treat 4xx as server error", () => {
    const err = Object.assign(new Error("not found"), { status: 404 })
    expect(extractErrorMessage(err)).toBe("not found")
  })

  test("returns string errors as-is", () => {
    expect(extractErrorMessage("connection reset")).toBe("connection reset")
  })

  test("returns Unknown error for null", () => {
    expect(extractErrorMessage(null)).toBe("Unknown error")
  })

  test("returns Unknown error for undefined", () => {
    expect(extractErrorMessage(undefined)).toBe("Unknown error")
  })

  test("returns Unknown error for number", () => {
    expect(extractErrorMessage(42)).toBe("Unknown error")
  })

  test("returns Unknown error for plain object", () => {
    expect(extractErrorMessage({ message: "ignored" })).toBe("Unknown error")
  })
})
