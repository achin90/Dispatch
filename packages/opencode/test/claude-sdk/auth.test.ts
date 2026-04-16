import { describe, test, expect, spyOn, afterEach } from "bun:test"
import { resolveApiKey } from "../../src/session/claude-sdk-query"
import { AppRuntime } from "../../src/effect/app-runtime"

describe("claude-sdk auth", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  describe("resolveApiKey", () => {
    test("returns env var when ANTHROPIC_API_KEY is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-env-key"

      const key = await resolveApiKey()
      expect(key).toBe("sk-test-env-key")
    })

    test("falls back to Auth store when no env var", async () => {
      delete process.env.ANTHROPIC_API_KEY

      const runSpy = spyOn(AppRuntime, "runPromise").mockResolvedValue({
        type: "api",
        key: "sk-test-auth-store-key",
      } as any)

      const key = await resolveApiKey()
      expect(key).toBe("sk-test-auth-store-key")
      expect(runSpy).toHaveBeenCalled()

      runSpy.mockRestore()
    })

    test("returns undefined when no credentials found", async () => {
      delete process.env.ANTHROPIC_API_KEY

      const runSpy = spyOn(AppRuntime, "runPromise").mockResolvedValue(undefined as any)

      const key = await resolveApiKey()
      expect(key).toBeUndefined()

      runSpy.mockRestore()
    })

    test("ignores OAuth auth entries (only uses api type)", async () => {
      delete process.env.ANTHROPIC_API_KEY

      const runSpy = spyOn(AppRuntime, "runPromise").mockResolvedValue({
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 3600000,
      } as any)

      const key = await resolveApiKey()
      expect(key).toBeUndefined()

      runSpy.mockRestore()
    })

    test("env var takes precedence over Auth store", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-env-wins"

      const runSpy = spyOn(AppRuntime, "runPromise").mockResolvedValue({
        type: "api",
        key: "sk-store-loses",
      } as any)

      const key = await resolveApiKey()
      expect(key).toBe("sk-env-wins")
      // AppRuntime.runPromise should NOT be called since env var was found
      expect(runSpy).not.toHaveBeenCalled()

      runSpy.mockRestore()
    })
  })
})
