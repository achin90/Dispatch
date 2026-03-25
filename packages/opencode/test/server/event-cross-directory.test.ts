import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

describe("event route cross-directory", () => {
  test("Bus.publish emits to GlobalBus with directory", async () => {
    await using tmp = await tmpdir()
    const seen: { directory?: string; payload: any }[] = []
    const handler = (evt: { directory?: string; payload: any }) => {
      seen.push(evt)
    }
    GlobalBus.on("event", handler)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Bus.publish(
            { type: "test.event", properties: {} } as any,
            { foo: "bar" },
          )
        },
      })
      const testEvents = seen.filter((e) => e.payload.type === "test.event")
      expect(testEvents.length).toBe(1)
      expect(testEvents[0].directory).toBe(tmp.path)
      expect(testEvents[0].payload).toEqual({
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
      await Instance.provide({
        directory: tmpA.path,
        fn: async () => {
          await Bus.publish(
            { type: "test.from.a", properties: {} } as any,
            { source: "A" },
          )
        },
      })
      await Instance.provide({
        directory: tmpB.path,
        fn: async () => {
          await Bus.publish(
            { type: "test.from.b", properties: {} } as any,
            { source: "B" },
          )
        },
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
})
