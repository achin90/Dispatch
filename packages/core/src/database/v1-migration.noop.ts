import { Effect, Layer } from "effect"

export type Status = { readonly status: "completed" }

export const layer = Layer.empty
export function status() {
  return Effect.succeed({ status: "completed" } as const)
}
export function run() {
  return Effect.succeed({ status: "completed" } as const)
}
// Dispatch: the incremental legacy import has nothing to do without the bun migration.
export function importMissing() {
  return Effect.succeed([] as ReadonlyArray<string>)
}
