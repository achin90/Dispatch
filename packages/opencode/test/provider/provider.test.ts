import { test, expect } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin/index"
import { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { Env } from "../../src/env"

function paid(providers: Awaited<ReturnType<typeof Provider.list>>) {
  const item = providers[ProviderID.make("opencode")]
  expect(item).toBeDefined()
  return Object.values(item.models).filter((model) => model.cost.input > 0).length
}

// ──────────────────────────────────────────────────────────────────────────
// Provider.list() — returns only the hardcoded Anthropic / Claude Agent SDK
// provider with source:"env", env:["ANTHROPIC_API_KEY"], options:{}, and
// models built from the static SDK_MODELS list (default, sonnet, sonnet[1m],
// haiku).
// ──────────────────────────────────────────────────────────────────────────

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.anthropic].source).toBe("env")
      expect(providers[ProviderID.anthropic].env).toEqual(["ANTHROPIC_API_KEY"])
      expect(providers[ProviderID.anthropic].options).toEqual({})
    },
  })
})

test("list returns only anthropic provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const ids = Object.keys(providers)
      expect(ids).toEqual(["anthropic"])
    },
  })
})

test("list returns SDK models: default, sonnet, sonnet[1m], haiku", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const models = Object.keys(providers[ProviderID.anthropic].models)
      expect(models).toContain("default")
      expect(models).toContain("sonnet")
      expect(models).toContain("sonnet[1m]")
      expect(models).toContain("haiku")
      expect(models.length).toBe(4)
    },
  })
})

test("SDK model default has correct properties", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["default"]
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBe(1_000_000)
      expect(model.limit.output).toBe(64_000)
    },
  })
})

test("SDK model haiku has reasoning disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["haiku"]
      expect(model).toBeDefined()
      expect(model.capabilities.reasoning).toBe(false)
      expect(model.limit.context).toBe(200_000)
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// getModel — checks SDK models first, falls back to state()
// ──────────────────────────────────────────────────────────────────────────

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getModel(ProviderID.anthropic, ModelID.make("sonnet"))
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.id)).toBe("sonnet")
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      expect(Provider.getModel(ProviderID.anthropic, ModelID.make("nonexistent-model"))).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(Provider.getModel(ProviderID.make("nonexistent-provider"), ModelID.make("some-model"))).rejects.toThrow()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model1 = await Provider.getModel(ProviderID.anthropic, ModelID.make("sonnet"))
      const model2 = await Provider.getModel(ProviderID.anthropic, ModelID.make("sonnet"))
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// parseModel
// ──────────────────────────────────────────────────────────────────────────

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

// ──────────────────────────────────────────────────────────────────────────
// defaultModel
// ──────────────────────────────────────────────────────────────────────────

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// closest
// ──────────────────────────────────────────────────────────────────────────

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest(ProviderID.anthropic, ["sonnet"])
      expect(result).toBeDefined()
      expect(String(result?.providerID)).toBe("anthropic")
      expect(String(result?.modelID)).toContain("sonnet")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Provider.closest(ProviderID.make("nonexistent"), ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await Provider.closest(ProviderID.anthropic, ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // First term won't match, second will
      const result = await Provider.closest(ProviderID.anthropic, ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// getSmallModel
// ──────────────────────────────────────────────────────────────────────────

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          small_model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await Provider.getSmallModel(ProviderID.anthropic)
      expect(model).toBeDefined()
      expect(String(model?.providerID)).toBe("anthropic")
      expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// sort
// ──────────────────────────────────────────────────────────────────────────

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

// ──────────────────────────────────────────────────────────────────────────
// ModelNotFoundError
// ──────────────────────────────────────────────────────────────────────────

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonet-4")) // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await Provider.getModel(ProviderID.make("antropic"), ModelID.make("claude-sonnet-4")) // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// getProvider
// ──────────────────────────────────────────────────────────────────────────

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await Provider.getProvider(ProviderID.make("nonexistent"))
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const provider = await Provider.getProvider(ProviderID.anthropic)
      expect(provider).toBeDefined()
      expect(String(provider?.id)).toBe("anthropic")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("no-limit")].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Custom options should be merged
      expect(providers[ProviderID.anthropic].options.timeout).toBe(30000)
      expect(providers[ProviderID.anthropic].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers[ProviderID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits npm package from models.dev provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.openai].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits api.url from models.dev provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENROUTER_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.openrouter]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers[ProviderID.openrouter].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers[ProviderID.openrouter].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("mode cost preserves over-200k pricing from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
              },
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.cost.input).toEqual(5)
  expect(model.cost.output).toEqual(30)
  expect(model.cost.cache.read).toEqual(0.5)
  expect(model.cost.cache.write).toEqual(0)
  expect(model.options["serviceTier"]).toEqual("priority")
  expect(model.cost.experimentalOver200K).toEqual({
    input: 5,
    output: 22.5,
    cache: {
      read: 0.5,
      write: 0,
    },
  })
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      // Claude sonnet 4 has reasoning capability
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // max variant should still exist
      expect(model.variants!["max"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: { disabled: true },
                    max: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.anthropic].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated thinking config and the custom option
      expect(model.variants!["high"].thinking).toBeDefined()
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for database models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            openai: {
              models: {
                "gpt-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.openai].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("custom-reasoning")].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

test("Google Vertex: retains baseURL for custom proxy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-proxy": {
              name: "Vertex Proxy",
              npm: "@ai-sdk/google-vertex",
              api: "https://my-proxy.com/v1",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"], // Mock env var requirement
              models: {
                "gemini-pro": {
                  name: "Gemini Pro",
                  tool_call: true,
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
                baseURL: "https://my-proxy.com/v1", // Should be retained
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("vertex-proxy")]).toBeDefined()
      expect(providers[ProviderID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
    },
  })
})

test("Google Vertex: supports OpenAI compatible models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "vertex-openai": {
              name: "Vertex OpenAI",
              npm: "@ai-sdk/google-vertex",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.openai.com/v1",
                  },
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.make("vertex-openai")].models["gpt-4"]

      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

test("cloudflare-ai-gateway loads with env variables", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      Env.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      Env.set("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
    },
  })
})

test("cloudflare-ai-gateway forwards config metadata options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            "cloudflare-ai-gateway": {
              options: {
                metadata: { invoked_by: "test", project: "opencode" },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
      Env.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      Env.set("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
        invoked_by: "test",
        project: "opencode",
      })
    },
  })
})

test("plugin config providers persist after instance dispose", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const root = path.join(dir, ".opencode", "plugin")
      await mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, "demo-provider.ts"),
        [
          "export default {",
          '  id: "demo.plugin-provider",',
          "  server: async () => ({",
          "    async config(cfg) {",
          "      cfg.provider ??= {}",
          "      cfg.provider.demo = {",
          '        name: "Demo Provider",',
          '        npm: "@ai-sdk/openai-compatible",',
          '        api: "https://example.com/v1",',
          "        models: {",
          "          chat: {",
          '            name: "Demo Chat",',
          "            tool_call: true,",
          "            limit: { context: 128000, output: 4096 },",
          "          },",
          "        },",
          "      }",
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  const first = await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Plugin.init()
      return Provider.list()
    },
  })
  expect(first[ProviderID.make("demo")]).toBeDefined()
  expect(first[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()

  await Instance.disposeAll()

  const second = await Instance.provide({
    directory: tmp.path,
    fn: async () => Provider.list(),
  })
  expect(second[ProviderID.make("demo")]).toBeDefined()
  expect(second[ProviderID.make("demo")].models[ModelID.make("chat")]).toBeDefined()
})

test("plugin config enabled and disabled providers are honored", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const root = path.join(dir, ".opencode", "plugin")
      await mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, "provider-filter.ts"),
        [
          "export default {",
          '  id: "demo.provider-filter",',
          "  server: async () => ({",
          "    async config(cfg) {",
          '      cfg.enabled_providers = ["anthropic", "openai"]',
          '      cfg.disabled_providers = ["openai"]',
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "test-anthropic-key")
      Env.set("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers[ProviderID.anthropic]).toBeDefined()
      expect(providers[ProviderID.openai]).toBeUndefined()
    },
  })
})

test("opencode loader keeps paid models when config apiKey is present", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })

  const none = await Instance.provide({
    directory: base.path,
    fn: async () => paid(await Provider.list()),
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            opencode: {
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })

  const keyedCount = await Instance.provide({
    directory: keyed.path,
    fn: async () => paid(await Provider.list()),
  })

  expect(none).toBe(0)
  expect(keyedCount).toBeGreaterThan(0)
})

test("opencode loader keeps paid models when auth exists", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })

  const none = await Instance.provide({
    directory: base.path,
    fn: async () => paid(await Provider.list()),
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
        }),
      )
    },
  })

  const authPath = path.join(Global.Path.data, "auth.json")
  let prev: string | undefined

  try {
    prev = await Filesystem.readText(authPath)
  } catch {}

  try {
    await Filesystem.write(
      authPath,
      JSON.stringify({
        opencode: {
          type: "api",
          key: "test-key",
        },
      }),
    )

    const keyedCount = await Instance.provide({
      directory: keyed.path,
      fn: async () => paid(await Provider.list()),
    })

    expect(none).toBe(0)
    expect(keyedCount).toBeGreaterThan(0)
  } finally {
    if (prev !== undefined) {
      await Filesystem.write(authPath, prev)
    }
    if (prev === undefined) {
      try {
        await unlink(authPath)
      } catch {}
    }
  }
})
