import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, type Scope } from "effect"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SdkFork } from "../src/sdk/fork"
import { SdkSessionMap } from "../src/sdk/session-map"
import { sessionID, setup } from "./fixture"

/** A real Session service over a fresh database, the test Session holding one delivered prompt. */
const run = <A, E>(effect: Effect.Effect<A, E, Session.Service | Bus.Service | Database.Service | Scope.Scope>) => {
  const directory = AbsolutePath.make(realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-fork-"))))
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Bus.node,
      Location.node,
      Database.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      FileAccess.node,
      Form.node,
      Session.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory,
            workspaceID: undefined,
            project: { id: Project.ID.global, directory, canonical: directory },
            vcs: undefined,
          }),
        ),
      ),
    ],
  )
  const prompted = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    yield* sessions.prompt({ sessionID, text: "Fork context", resume: false })
    yield* SessionInbox.promote(db, bus, sessionID, "steer")
  })
  return Effect.runPromise(
    setup(directory, []).pipe(
      Effect.andThen(prompted),
      Effect.andThen(effect),
      Effect.scoped,
      Effect.provide(layer),
    ) as Effect.Effect<A, E>,
  )
}

/** Starts the fork service with a fake SDK copy, forks the test Session, and waits for the copy. */
const fork = (input: { readonly before?: boolean }) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const copies: Array<{ uuid: string; cwd: string }> = []
    yield* SdkFork.make({
      fork: async (uuid, cwd) => {
        copies.push({ uuid, cwd })
        return "uuid-fork"
      },
    })
    yield* SdkSessionMap.write(sessionID, { uuid: "uuid-parent", cwd: "/repo" })
    const message = yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).get().pipe(Effect.orDie)
    const forked = yield* sessions.fork({ sessionID, ...(input.before && message ? { before: message.id } : {}) })
    // The copy runs on the event; give it a few turns of the scheduler.
    for (let attempt = 0; attempt < 50 && copies.length === 0; attempt++) yield* Effect.sleep(5)
    yield* Effect.sleep(20)
    return { copies, fork: yield* sessions.get(forked.id) }
  })

describe("SdkFork", () => {
  test("a whole-session fork gets its own copy of the parent's SDK conversation", async () => {
    const result = await run(fork({}))
    expect(result.copies).toEqual([{ uuid: "uuid-parent", cwd: "/repo" }])
    expect(SdkSessionMap.read(result.fork)).toEqual({ uuid: "uuid-fork", cwd: "/repo" })
  })

  test("a fork from an earlier message starts a fresh SDK conversation", async () => {
    const result = await run(fork({ before: true }))
    expect(result.copies).toEqual([])
    expect(SdkSessionMap.read(result.fork)).toBeUndefined()
  })
})
