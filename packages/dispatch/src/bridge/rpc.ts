export * as DispatchBridgeRpc from "./rpc.js"

import { Rpc } from "@opencode/core/rpc"
import { SessionSchema } from "@opencode/core/session/schema"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Schema } from "effect"
import { DispatchBridge } from "./service.js"

/**
 * The claude.ai mirroring API, called as `POST /api/rpc/dispatch-bridge/<method>` with
 * `{ input }`. A separate id from Dispatch's `dispatch` RPC: one id resolves to a single (the last)
 * registration, so two registrations of `dispatch` would hide each other's methods.
 *
 * Every Location registers it, and the handlers only use process-wide state, so the request's
 * Location (the `directory` the client sends) does not matter.
 */
export const ID = "dispatch-bridge"

const Unavailable = Schema.Struct({ reason: Schema.String })

export const Definition = Rpc.define({
  id: ID,
  methods: {
    /** Starts (or resumes) mirroring a Session to claude.ai; returns its `cse_*` id. */
    "session.remoteControl": {
      input: Schema.Struct({ sessionID: SessionSchema.ID }),
      output: Schema.Struct({ codeSessionID: Schema.String }),
      errors: { "remote.unavailable": Unavailable, "session.not_found": Unavailable },
    },
    /** Stops mirroring; false when the Session was not mirrored. */
    "session.remoteControlStop": {
      input: Schema.Struct({ sessionID: SessionSchema.ID }),
      output: Schema.Boolean,
    },
    /** Session IDs with a live mirror. */
    "session.remoteControlList": {
      input: Schema.Unknown,
      output: Schema.Array(Schema.String),
    },
  },
  events: {},
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const bridge = yield* DispatchBridge.Service
    yield* rpc.register(Definition, {
      "session.remoteControl": (input, context) =>
        bridge.attach(input.sessionID).pipe(
          Effect.map((codeSessionID) => ({ codeSessionID })),
          Effect.catchTag("DispatchBridge.UnavailableError", (error) =>
            Effect.fail(context.error("remote.unavailable", error.reason, { reason: error.reason })),
          ),
          Effect.catchTag("Session.NotFoundError", () =>
            Effect.fail(
              context.error("session.not_found", `Session not found: ${input.sessionID}`, {
                reason: `Session not found: ${input.sessionID}`,
              }),
            ),
          ),
        ),
      "session.remoteControlStop": (input) => bridge.detach(input.sessionID),
      "session.remoteControlList": () => Effect.sync(() => bridge.list()),
    }).pipe(Effect.orDie)
  }),
)

/** Has no service of its own; the runner node depends on it so every Location registers the RPC. */
export const node = makeLocationNode({
  name: "@opencode/dispatch/BridgeRpc",
  layer,
  deps: [Rpc.node, DispatchBridge.node],
})
