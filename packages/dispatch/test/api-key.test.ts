import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { SdkEnv } from "../src/sdk/env"
import { SdkModels } from "../src/sdk/models"

const anthropic = Integration.ID.make(SdkModels.providerID)

/** Resolves the key against real Integration and Credential services holding `stored`, if any. */
const resolve = (stored?: Credential.Value) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      if (stored) yield* credentials.create({ integrationID: anthropic, value: stored })
      return yield* SdkEnv.apiKey(integrations)
    }).pipe(
      Effect.scoped,
      Effect.provide(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node]))),
    ),
  )

const key = (value: string) => Credential.Key.make({ type: "key", key: value })

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
})

// Dispatch regression guard (v1 auth.test.ts): which key the spawned CLI gets.
describe("SdkEnv.apiKey", () => {
  test("ANTHROPIC_API_KEY wins over a stored key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-wins"
    expect(await resolve(key("sk-store-loses"))).toBe("sk-env-wins")
  })

  test("a stored Anthropic key is used when the environment has none", async () => {
    expect(await resolve(key("sk-stored"))).toBe("sk-stored")
  })

  test("OAuth credentials are not API keys, so the CLI falls back to its own login", async () => {
    expect(
      await resolve(
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("claude"),
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 3_600_000,
        }),
      ),
    ).toBeUndefined()
  })

  test("no credential at all is undefined", async () => {
    expect(await resolve()).toBeUndefined()
  })
})
