import { describe, expect, test } from "bun:test"
import { SdkModels } from "../src/sdk/models"

// Dispatch regression guard for the static Claude Agent SDK models.
describe("SDK models", () => {
  test("contains the expected aliases and opus-5-5 is the default", () => {
    expect(Object.keys(SdkModels.definitions)).toEqual(
      expect.arrayContaining(["default", "fable-5-1", "opus-5-5", "opus-4-6[1m]", "sonnet", "haiku"]),
    )
    expect(SdkModels.DEFAULT).toBe("opus-5-5")
    expect(SdkModels.definitions.default.resolves).toBe(SdkModels.definitions["opus-5-5"].resolves)
  })

  test("every 1M Opus entry carries the [1m] suffix", () => {
    for (const [alias, definition] of Object.entries(SdkModels.definitions)) {
      if (!definition.resolves.includes("opus") || definition.context !== 1_000_000) continue
      expect(definition.resolves, `${alias} claims 1M but omits [1m]`).toContain("[1m]")
    }
  })

  test("sonnet is native 1M without the suffix; haiku has no reasoning", () => {
    expect(SdkModels.definitions.sonnet.resolves).toBe("claude-sonnet-5")
    expect(SdkModels.definitions.sonnet.context).toBe(1_000_000)
    expect(SdkModels.definitions.haiku.reasoning).toBe(false)
    expect(SdkModels.info("haiku", SdkModels.definitions.haiku).variants).toEqual([])
  })

  test("model info", () => {
    const info = SdkModels.info("opus-5-5", SdkModels.definitions["opus-5-5"])
    expect(String(info.providerID)).toBe("anthropic")
    expect(String(info.id)).toBe("opus-5-5")
    expect(String(info.modelID)).toBe("claude-opus-5-5[1m]")
    expect(String(info.family)).toBe("claude-opus")
    expect(info.package).toBe(SdkModels.PACKAGE)
    expect(info.settings?.sdkDescription).toBe("Most capable for complex work")
    expect(info.limit).toEqual({ context: 1_000_000, output: 64_000 })
    expect(info.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(SdkModels.info("default", SdkModels.definitions.default).status).toBe("deprecated")
  })

  test("effort ladders", () => {
    expect(SdkModels.efforts("claude-fable-5-1", true)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(SdkModels.efforts("claude-opus-4-6[1m]", true)).toEqual(["low", "medium", "high", "max"])
    expect(SdkModels.efforts("claude-opus-4-5", true)).toEqual([])
  })

  test("the CLI model id for an alias, and catalog ids pass through", () => {
    expect(SdkModels.cliModel("opus-5-5")).toBe("claude-opus-5-5[1m]")
    expect(SdkModels.cliModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(SdkModels.normalizeWireModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5")
  })

  test("only the anthropic provider routes to the SDK runner", () => {
    expect(SdkModels.isSdkModel({ providerID: "anthropic" })).toBe(true)
    expect(SdkModels.isSdkModel({ providerID: "opencode-go" })).toBe(false)
  })
})
