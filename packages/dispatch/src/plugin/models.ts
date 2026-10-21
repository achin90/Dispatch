export * as DispatchModelsPlugin from "./models.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Provider } from "@opencode/core/provider"
import { Effect } from "effect"
import { SdkLanguageModel } from "../sdk/language-model.js"
import { SdkModels } from "../sdk/models.js"

/**
 * Puts the Anthropic provider on the Claude Agent SDK: the static SDK models (opus-5-5 by default),
 * no credential required (the CLI falls back to the Claude Code login), and every Anthropic model
 * resolving to the in-process SDK language model so single-shot callers work for subscription users.
 */
export const Plugin = define({
  id: "dispatch.models",
  effect: Effect.fn("DispatchModelsPlugin")(function* (ctx) {
    yield* ctx.provider.transform((editor) => {
      const existing = editor.get(SdkModels.providerID)
      const catalog = existing?.models ?? new Map()
      const statics = Object.entries(SdkModels.definitions).map(([alias, definition]) =>
        SdkModels.info(alias, definition, definition.catalog ? (catalog.get(definition.catalog)?.cost ?? []) : []),
      )
      const aliases = new Set(statics.map((model) => model.id as string))
      const others = Array.from(catalog.values())
        .filter((model) => !aliases.has(model.id))
        .map((model) => ({ ...model, package: SdkModels.PACKAGE }))
      if (!existing)
        return editor.add({
          info: { id: SdkModels.providerID, name: "Anthropic", activation: "enabled", package: SdkModels.PACKAGE },
          models: statics,
        })
      editor.update(SdkModels.providerID, (provider) => {
        provider.activation = "enabled"
        provider.package = SdkModels.PACKAGE
      })
      editor.models.set(SdkModels.providerID, [...statics, ...others])
    })
    yield* ctx.model.transform((editor) => {
      if (!editor.default.get()) editor.default.set(SdkModels.providerID, SdkModels.DEFAULT)
    })
    yield* ctx.aisdk.hook("sdk", (event) =>
      Effect.sync(() => {
        if (event.package !== Provider.packageName(SdkModels.PACKAGE)) return
        const apiKey = typeof event.options.apiKey === "string" ? event.options.apiKey : undefined
        event.sdk = { languageModel: (modelID: string) => SdkLanguageModel.make(modelID, apiKey) }
      }),
    )
  }),
})
