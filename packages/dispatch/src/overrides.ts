export * as DispatchOverrides from "./overrides.js"

import type { LayerNode } from "@opencode/util/effect/layer-node"
import { DispatchPlugins } from "./plugin/register.js"
import { DispatchLocation } from "./location.js"

/** Layer replacements the Dispatch server passes to `createRoutes`. */
export const replacements: LayerNode.Replacements = [...DispatchLocation.replacements, ...DispatchPlugins.replacements]
