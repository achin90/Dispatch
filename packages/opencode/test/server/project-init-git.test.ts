import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Snapshot } from "../../src/snapshot"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Filesystem } from "../../src/util/filesystem"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("project.initGit endpoint", () => {
  test("initializes git and reloads immediately", async () => {
    await using tmp = await tmpdir()
    const app = Server.Default().app
    const seen: { directory?: string; payload: Record<string, unknown> }[] = []
    const fn = (evt: { directory?: string; payload: Record<string, unknown> }) => {
      seen.push(evt)
    }
    const reload = Instance.reload
    const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
    GlobalBus.on("event", fn)

    try {
      const init = await app.request("/project/git/init", {
        method: "POST",
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(init.status).toBe(200)
      expect(await init.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
      expect(
        seen.filter((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed").length,
      ).toBe(0)
      expect(reloadSpy).toHaveBeenCalledTimes(0)

      const current = await app.request("/project/current", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
    } finally {
      await Instance.disposeAll()
      reloadSpy.mockRestore()
      GlobalBus.off("event", fn)
    }
  })
})
