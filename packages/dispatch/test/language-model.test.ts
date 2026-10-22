import { describe, expect, test } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import { SdkLanguageModel } from "../src/sdk/language-model"

describe("SDK language model errors", () => {
  test("an API 400 from the CLI carries its status and is not retried", () => {
    const error = SdkLanguageModel.apiError(
      new Error(
        "Claude Code returned an error result: API Error: 400 Third-party apps now draw from extra usage, not plan limits.",
      ),
    )
    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) return
    expect(error.statusCode).toBe(400)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain("Third-party apps")
  })

  test("rate limits and server errors stay retryable", () => {
    for (const status of [429, 500, 529]) {
      const error = SdkLanguageModel.apiError(new Error(`API Error: ${status} overloaded`))
      expect(APICallError.isInstance(error) && error.isRetryable).toBe(true)
    }
  })

  test("errors without an API status pass through unchanged", () => {
    const error = new Error("The Claude Agent SDK reported an error")
    expect(SdkLanguageModel.apiError(error)).toBe(error)
    expect(SdkLanguageModel.apiError("text")).toBe("text")
  })
})
