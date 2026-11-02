export * as DispatchPlugins from "./register.js"

import { Bus } from "@opencode/core/bus"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Effect, Layer } from "effect"
import { SdkFork } from "../sdk/fork.js"
import { DispatchModelsPlugin } from "./models.js"
import { DispatchAgentsPlugin } from "./agents.js"
import { DispatchCommandsPlugin } from "./commands.js"
import { DispatchWorktreePlugin } from "./worktree.js"

/** Dispatch's server plugins, contributed to every Location through the host plugin store. */
export const plugins: readonly Plugin[] = [
  DispatchModelsPlugin.Plugin,
  DispatchAgentsPlugin.Plugin,
  DispatchCommandsPlugin.Plugin,
  DispatchWorktreePlugin.Plugin,
]

/**
 * The host plugin store, seeded with the Dispatch plugins. Seeding happens before any
 * Location boots, so no `sdk.plugin.updated` notification is needed for them.
 */
const layer = Layer.effect(
  SdkPlugins.Service,
  Effect.gen(function* () {
    const seeded = plugins.map((plugin) => ({ ...plugin, revision: "dispatch", source: { type: "sdk" as const } }))
    const store = yield* SdkPlugins.Service
    return SdkPlugins.Service.of({ register: store.register, all: () => [...seeded, ...store.all()] })
  }),
).pipe(Layer.provide(SdkPlugins.layer))

/**
 * Also carries Dispatch's process-wide services that nothing else depends on (`SdkFork`). This node
 * is built once with the server; a global node reached only through a Location node is built in the
 * first Location's scope instead, and stops when that Location is invalidated.
 */
export const node = makeGlobalNode({ service: SdkPlugins.Service, layer, deps: [Bus.node, SdkFork.node] })

export const replacements: LayerNode.Replacements = [SdkPlugins.node.replace(node)]
