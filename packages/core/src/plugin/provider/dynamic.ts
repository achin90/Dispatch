import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Npm } from "@opencode/util/npm"
import { loadSDKFactory } from "./sdk-factory.js"

export const DynamicProviderPlugin = define({
  id: "opencode.provider.dynamic",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        // Dispatch: the Dispatch plugin answers its own in-process package; never npm-install it.
        if (evt.sdk || evt.package.startsWith("@opencode/dispatch/")) return

        evt.sdk = ((yield* loadSDKFactory(npm, evt.package)) as (options: any) => any)(evt.options)
      }),
    )
  }),
})
