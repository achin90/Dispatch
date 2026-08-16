import { afterEach, describe, expect, test } from "bun:test"
import { WithInstance } from "@/project/with-instance"
import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { GlobalBus } from "../../src/bus/global"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

// Ad-hoc events used only by this test. EventV2 publishes against a definition
// rather than an inline `{ type, properties }` object, so declare them up front.
const TestEvent = EventV2.define({ type: "test.event", schema: { foo: Schema.String } })
const TestFromA = EventV2.define({ type: "test.from.a", schema: { source: Schema.String } })
const TestFromB = EventV2.define({ type: "test.from.b", schema: { source: Schema.String } })
const TestWorkspace = EventV2.define({ type: "test.workspace", schema: { data: Schema.Number } })

// Publish through the opencode bridge — this is the seam that stamps the
// instance location onto the event and forwards it to GlobalBus (the old
// Bus.publish -> GlobalBus.emit path these tests were written against).
function publish<D extends EventV2.Definition>(definition: D, data: D["data"]["Type"]) {
  return AppRuntime.runPromise(EventV2Bridge.Service.use((events) => events.publish(definition, data)))
}

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

describe("event route cross-directory", () => {
  test("publish emits to GlobalBus with directory", async () => {
    await using tmp = await tmpdir()
    const seen: { directory?: string; payload: any }[] = []
    const handler = (evt: { directory?: string; payload: any }) => {
      seen.push(evt)
    }
    GlobalBus.on("event", handler)
    try {
      await WithInstance.provide({
        directory: tmp.path,
        fn: () => publish(TestEvent, { foo: "bar" }),
      })
      const testEvents = seen.filter((e) => e.payload.type === "test.event")
      expect(testEvents.length).toBe(1)
      expect(testEvents[0].directory).toBe(tmp.path)
      // upstream now stamps every event with an ascending `id`; assert on content only
      expect(testEvents[0].payload).toMatchObject({
        type: "test.event",
        properties: { foo: "bar" },
      })
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("GlobalBus events from different directory are distinguishable", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const seen: { directory?: string; payload: any }[] = []
    const handler = (evt: { directory?: string; payload: any }) => {
      seen.push(evt)
    }
    GlobalBus.on("event", handler)
    try {
      await WithInstance.provide({
        directory: tmpA.path,
        fn: () => publish(TestFromA, { source: "A" }),
      })
      await WithInstance.provide({
        directory: tmpB.path,
        fn: () => publish(TestFromB, { source: "B" }),
      })

      const fromA = seen.find((e) => e.payload.type === "test.from.a")
      const fromB = seen.find((e) => e.payload.type === "test.from.b")

      expect(fromA).toBeDefined()
      expect(fromA!.directory).toBe(tmpA.path)
      expect(fromB).toBeDefined()
      expect(fromB!.directory).toBe(tmpB.path)
      expect(fromA!.directory).not.toBe(fromB!.directory)
    } finally {
      GlobalBus.off("event", handler)
    }
  })

  test("GlobalBus skips same-directory events to prevent duplicates", async () => {
    // The SSE event route listens to both Bus (local) and GlobalBus (cross-dir).
    // Events from the SAME directory arrive via Bus already, so GlobalBus must
    // skip them to avoid duplicate delivery. This test verifies the filter.
    await using tmp = await tmpdir()

    const dir = tmp.path
    const forwarded: Record<string, unknown>[] = []

    // Simulate the server-side duplicate prevention filter from event.ts:
    // const currentDirectory = Instance.directory
    // if (directory === currentDirectory) return
    const filter = ({ directory, payload }: { directory?: string; payload: Record<string, unknown> }) => {
      if (directory === dir) return // same dir → skip (duplicate prevention)
      forwarded.push(payload)
    }
    GlobalBus.on("event", filter)

    try {
      // Emit from same directory — should be filtered out
      GlobalBus.emit("event", {
        directory: dir,
        payload: { type: "same.dir.event", properties: {} },
      })

      // Emit from different directory — should pass through
      GlobalBus.emit("event", {
        directory: "/some/other/worktree",
        payload: { type: "cross.dir.event", properties: {} },
      })

      // Emit with undefined directory — should pass through
      GlobalBus.emit("event", {
        directory: undefined,
        payload: { type: "undefined.dir.event", properties: {} },
      })

      expect(forwarded).toHaveLength(2)
      expect(forwarded[0]).toMatchObject({ type: "cross.dir.event", properties: {} })
      expect(forwarded[1]).toMatchObject({ type: "undefined.dir.event", properties: {} })
    } finally {
      GlobalBus.off("event", filter)
    }
  })

  test("GlobalBus includes workspace metadata", async () => {
    await using tmp = await tmpdir()
    const seen: { directory?: string; workspace?: string; payload: any }[] = []
    const handler = (evt: { directory?: string; workspace?: string; payload: any }) => {
      seen.push(evt)
    }
    GlobalBus.on("event", handler)
    try {
      await WithInstance.provide({
        directory: tmp.path,
        fn: () => publish(TestWorkspace, { data: 1 }),
      })

      const evt = seen.find((e) => e.payload.type === "test.workspace")
      expect(evt).toBeDefined()
      // workspace may be undefined if no workspace context, but the field should exist
      expect("workspace" in evt!).toBe(true)
    } finally {
      GlobalBus.off("event", handler)
    }
  })
})
