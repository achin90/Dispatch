import { Effect } from "effect"

/**
 * Logging bridge for code that runs outside of an Effect context.
 *
 * Upstream removed `@opencode-ai/core/util/log` in favor of Effect logging
 * (`yield* Effect.logInfo(...)`). Most Dispatch code follows that pattern, but
 * the Claude Agent SDK integration does much of its work inside raw async
 * callbacks (`canUseTool`, MCP tool handlers, `Effect.promise` closures) where
 * there is no fiber to `yield*` on. These helpers forward the same messages to
 * the Effect logger through the app runtime so they still land in the
 * configured log file.
 *
 * `@/effect/app-runtime` is imported lazily because several modules that use
 * this bridge are themselves part of the AppLayer — a static import would
 * create a module cycle.
 */
type Fields = Record<string, unknown>

function emit(effect: Effect.Effect<void>) {
  void import("@/effect/app-runtime")
    .then(({ AppRuntime }) => AppRuntime.runPromise(effect.pipe(Effect.catchCause(() => Effect.void))))
    .catch(() => {})
}

export function create(options: { service: string }) {
  const fields = (input?: Fields) => ({ service: options.service, ...(input ?? {}) })
  return {
    debug: (message: string, input?: Fields) => emit(Effect.logDebug(message, fields(input))),
    info: (message: string, input?: Fields) => emit(Effect.logInfo(message, fields(input))),
    warn: (message: string, input?: Fields) => emit(Effect.logWarning(message, fields(input))),
    error: (message: string, input?: Fields) => emit(Effect.logError(message, fields(input))),
  }
}
