import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRunPromise } from "@/effect/run-service"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Log } from "../util/log"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
        activity: z.string().optional(),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Info>
    readonly list: () => Effect.Effect<Map<SessionID, Info>>
    readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionStatus") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
      )

      const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        return data.get(sessionID) ?? { type: "idle" as const }
      })

      const list = Effect.fn("SessionStatus.list")(function* () {
        return new Map(yield* InstanceState.get(state))
      })

      const latency = Log.create({ service: "submit.latency" })

      const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
        const data = yield* InstanceState.get(state)
        latency.info("[5] SessionStatus.set pre-publish", { ts: Date.now(), type: status.type, sessionID })
        yield* Effect.promise(() => Bus.publish(Event.Status, { sessionID, status }))
        latency.info("[5b] SessionStatus.set post-publish", { ts: Date.now(), type: status.type, sessionID })
        if (status.type === "idle") {
          yield* Effect.promise(() => Bus.publish(Event.Idle, { sessionID }))
          data.delete(sessionID)
          return
        }
        data.set(sessionID, status)
      })

      return Service.of({ get, list, set })
    }),
  )

  const runPromise = makeRunPromise(Service, layer)

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function set(sessionID: SessionID, status: Info) {
    return runPromise((svc) => svc.set(sessionID, status))
  }
}
