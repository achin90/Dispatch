export * as DispatchOverrides from "./overrides.js"

import type { LayerNode } from "@opencode/util/effect/layer-node"
import { DispatchPlugins } from "./plugin/register.js"
import { DispatchRunner } from "./runner/node.js"

/** Layer replacements the Dispatch server passes to `createRoutes`. */
export const replacements: LayerNode.Replacements = [...DispatchRunner.replacements, ...DispatchPlugins.replacements]
