import { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"

const log = Log.create({ service: "server" })

export const EventPaths = {
  event: "/event",
} as const

export const EventApi = HttpApi.make("event").add(
  HttpApiGroup.make("event")
    .add(
      HttpApiEndpoint.get("subscribe", EventPaths.event, {
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "event.subscribe",
          summary: "Subscribe to events",
          description: "Get events",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "event", description: "Instance event stream route." })),
)

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse(bus: Bus.Interface, currentDirectory: string) {
  const events = bus.subscribeAll().pipe(Stream.takeUntil((event) => event.type === Bus.InstanceDisposed.type))

  // Dispatch: agent sessions running in worktree directories publish to their
  // own instance bus, so a TUI subscribed to this instance would never see
  // them. Bridge in GlobalBus events from OTHER directories; same-directory
  // events are skipped because subscribeAll already delivered them.
  const cross = Stream.callback<Record<string, unknown>>((queue) => {
    const handler = ({ directory, payload }: GlobalBusEvent) => {
      if (directory === currentDirectory) return
      Queue.offerUnsafe(queue, payload)
    }
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ id: Bus.createID(), type: "server.heartbeat", properties: {} })),
  )

  log.info("event connected")
  return HttpServerResponse.stream(
    Stream.make({ id: Bus.createID(), type: "server.connected", properties: {} }).pipe(
      Stream.concat(
        events.pipe(
          Stream.merge(cross, { haltStrategy: "left" }),
          Stream.merge(heartbeat, { haltStrategy: "left" }),
        ),
      ),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        const instance = yield* InstanceState.context
        return eventResponse(bus, instance.directory)
      }),
    )
  }),
)
