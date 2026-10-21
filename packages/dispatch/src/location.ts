export * as DispatchLocation from "./location.js"

import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { DispatchRpcNode } from "./rpc/node.js"
import { DispatchRunner } from "./runner/node.js"

/**
 * The Location's SessionRunner slot, filled by the Dispatch runner. A replacement can only swap an
 * existing node, so Dispatch's other location services (the `dispatch` RPC) ride along as deps of
 * this node, which re-exposes the runner unchanged.
 */
export const node = makeLocationNode({
  service: SessionRunner.Service,
  layer: Layer.effect(
    SessionRunner.Service,
    Effect.gen(function* () {
      return yield* SessionRunner.Service
    }),
  ),
  deps: [DispatchRunner.node, DispatchRpcNode.node],
})

export const replacements: LayerNode.Replacements = [SessionRunnerLLM.node.replace(node)]
