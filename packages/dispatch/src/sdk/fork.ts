export * as SdkFork from "./fork.js"

import { forkSession } from "@anthropic-ai/claude-agent-sdk"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Stream } from "effect"
import { SdkSessionMap } from "./session-map.js"

/**
 * Gives a fork of a Claude Agent SDK Session its own copy of the parent's SDK conversation.
 *
 * The SDK keeps the conversation itself and the runner only sends it new messages, so without this
 * a fork's first turn would start a fresh conversation that has never seen the copied history. The
 * copy is made as soon as the fork exists, so it matches what the fork shows even if the parent
 * keeps going. Only whole-session forks are copied: cutting the SDK conversation at an earlier
 * message is not mapped yet, so those forks still start fresh.
 */
export interface Dependencies {
  /** Copies an SDK conversation; returns the new conversation's id. */
  readonly fork: (uuid: string, cwd: string) => Promise<string>
}

export const defaults: Dependencies = {
  fork: (uuid, cwd) => forkSession(uuid, { dir: cwd }).then((result) => result.sessionId),
}

export class Service extends Context.Service<Service, {}>()("@opencode/dispatch/SdkFork") {}

export const make = Effect.fn("SdkFork.make")(function* (dependencies: Dependencies) {
  const bus = yield* Bus.Service
  const sessions = yield* Session.Service

  const copy = Effect.fn("SdkFork.copy")(function* (event: typeof SessionEvent.Forked.Type) {
    const fields = { sessionID: event.data.sessionID, parentID: event.data.parentID }
    yield* Effect.logInfo("session forked", { ...fields, boundary: event.data.boundary.type })
    if (event.data.boundary.type !== "through")
      return yield* Effect.logInfo("sdk fork skipped: forked from an earlier message", fields)
    const entry = SdkSessionMap.read(yield* sessions.get(event.data.parentID))
    if (!entry) return yield* Effect.logInfo("sdk fork skipped: parent has no SDK conversation", fields)
    const uuid = yield* Effect.promise(() => dependencies.fork(entry.uuid, entry.cwd))
    // A turn that already started on the fork recorded its own conversation; keep that one.
    if (SdkSessionMap.read(yield* sessions.get(event.data.sessionID)))
      return yield* Effect.logInfo("sdk fork skipped: fork already has an SDK conversation", fields)
    yield* SdkSessionMap.write(event.data.sessionID, { uuid, cwd: entry.cwd })
    yield* Effect.logInfo("forked claude agent sdk session", {
      sessionID: event.data.sessionID,
      parentID: event.data.parentID,
      uuid,
    })
  })

  yield* bus.subscribe(SessionEvent.Forked).pipe(
    Stream.runForEach((event) =>
      copy(event).pipe(
        Effect.provideService(Session.Service, sessions),
        Effect.catchCause((cause) => Effect.logWarning("failed to fork claude agent sdk session", { cause })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* Effect.logInfo("sdk fork listener started")
  yield* Effect.addFinalizer(() => Effect.logInfo("sdk fork listener stopped"))
  return Service.of({})
})

export const layer = Layer.effect(Service, make(defaults))

export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node, Session.node] })
