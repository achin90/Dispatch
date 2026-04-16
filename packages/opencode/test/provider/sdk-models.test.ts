import { describe, expect, test } from "bun:test"
import { SDK_MODELS, buildSdkModel } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"

// ---------------------------------------------------------------------------
// SDK_MODELS and buildSdkModel — Dispatch regression guard
//
// These static model definitions are the source of truth for Claude Agent SDK
// models. They must survive upstream merges intact. Tests verify:
// - All expected aliases exist
// - Model resolution IDs are correct
// - Family extraction works
// - Descriptions are stored in options
// - Capabilities are set correctly
// ---------------------------------------------------------------------------

describe("SDK_MODELS", () => {
  test("contains all expected aliases", () => {
    const aliases = Object.keys(SDK_MODELS)
    expect(aliases).toContain("default")
    expect(aliases).toContain("sonnet")
    expect(aliases).toContain("sonnet[1m]")
    expect(aliases).toContain("haiku")
  })

  test("each entry has required fields", () => {
    for (const [alias, info] of Object.entries(SDK_MODELS)) {
      expect(info.resolves).toBeString()
      expect(info.name).toBeString()
      expect(info.context).toBeGreaterThan(0)
      expect(info.output).toBeGreaterThan(0)
      expect(info.description).toBeString()
      expect(typeof info.reasoning).toBe("boolean")
    }
  })

  test("default resolves to opus 1M", () => {
    expect(SDK_MODELS.default.resolves).toContain("opus")
    expect(SDK_MODELS.default.context).toBe(1_000_000)
  })

  test("haiku has reasoning disabled", () => {
    expect(SDK_MODELS.haiku.reasoning).toBe(false)
  })

  test("sonnet variants have different context limits", () => {
    expect(SDK_MODELS.sonnet.context).toBe(200_000)
    expect(SDK_MODELS["sonnet[1m]"].context).toBe(1_000_000)
  })
})

describe("buildSdkModel", () => {
  const info = SDK_MODELS.default

  test("sets provider to anthropic", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(String(model.providerID)).toBe("anthropic")
  })

  test("sets model ID to alias", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(String(model.id)).toBe("default")
  })

  test("stores display name", () => {
    const model = buildSdkModel("default", info, "Custom Name")
    expect(model.name).toBe("Custom Name")
  })

  test("extracts family from resolved ID", () => {
    const model = buildSdkModel("default", info, info.name)
    // "claude-opus-4-6[1m]" → family "claude-opus"
    expect(model.family).toBe("claude-opus")
  })

  test("extracts family for sonnet", () => {
    const model = buildSdkModel("sonnet", SDK_MODELS.sonnet, "Sonnet")
    expect(model.family).toBe("claude-sonnet")
  })

  test("extracts family for haiku", () => {
    const model = buildSdkModel("haiku", SDK_MODELS.haiku, "Haiku")
    expect(model.family).toBe("claude-haiku")
  })

  test("stores description in options.sdkDescription", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.options.sdkDescription).toBe(info.description)
  })

  test("sets API npm to @ai-sdk/anthropic", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.api.npm).toBe("@ai-sdk/anthropic")
  })

  test("sets api.id to resolved model", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.api.id).toBe(info.resolves)
  })

  test("sets context and output limits", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.limit.context).toBe(info.context)
    expect(model.limit.output).toBe(info.output)
  })

  test("sets capabilities correctly", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.temperature).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.interleaved).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
    expect(model.capabilities.input.pdf).toBe(true)
    expect(model.capabilities.input.audio).toBe(false)
  })

  test("haiku model has reasoning disabled", () => {
    const model = buildSdkModel("haiku", SDK_MODELS.haiku, "Haiku")
    expect(model.capabilities.reasoning).toBe(false)
  })

  test("cost is zero for SDK models", () => {
    const model = buildSdkModel("default", info, info.name)
    expect(model.cost.input).toBe(0)
    expect(model.cost.output).toBe(0)
  })
})
