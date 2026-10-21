import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BridgeCredentials } from "../../src/bridge/credentials"

const valid = (overrides: Record<string, unknown> = {}) => ({
  claudeAiOauth: {
    accessToken: "sk-ant-oat-test",
    expiresAt: Date.now() + 60_000,
    scopes: ["user:inference", BridgeCredentials.SCOPE],
    ...overrides,
  },
})

describe("BridgeCredentials.check", () => {
  test("accepts a live token with the code-sessions scope", () => {
    expect(BridgeCredentials.check(valid())).toEqual({ token: "sk-ant-oat-test" })
  })

  test("rejects a missing, expired or under-scoped token", () => {
    expect("reason" in BridgeCredentials.check({})).toBe(true)
    expect("reason" in BridgeCredentials.check(valid({ accessToken: "" }))).toBe(true)
    expect(BridgeCredentials.check(valid({ expiresAt: Date.now() - 1 }))).toMatchObject({
      reason: expect.stringContaining("expired"),
    })
    expect(BridgeCredentials.check(valid({ scopes: ["user:inference"] }))).toMatchObject({
      reason: expect.stringContaining(BridgeCredentials.SCOPE),
    })
  })
})

describe("BridgeCredentials.read", () => {
  test("prefers ~/.claude/.credentials.json", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bridge-home-"))
    mkdirSync(path.join(home, ".claude"))
    writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify(valid()))
    const result = await BridgeCredentials.read({
      home,
      keychain: async () => {
        throw new Error("the keychain must not be read when the file exists")
      },
    })
    expect(result).toEqual({ token: "sk-ant-oat-test" })
  })

  test("falls back to the keychain entry", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bridge-home-"))
    expect(await BridgeCredentials.read({ home, keychain: async () => valid() })).toEqual({ token: "sk-ant-oat-test" })
    expect("reason" in (await BridgeCredentials.read({ home, keychain: async () => undefined }))).toBe(true)
  })
})
