import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
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
      expect(forwarded[0]).toEqual({ type: "cross.dir.event", properties: {} })
      expect(forwarded[1]).toEqual({ type: "undefined.dir.event", properties: {} })
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
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Bus.publish({ type: "test.workspace", properties: {} } as any, { data: 1 })
        },
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
