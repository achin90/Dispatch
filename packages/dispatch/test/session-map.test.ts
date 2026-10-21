import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
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
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, type Scope } from "effect"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SdkSessionMap } from "../src/sdk/session-map"
import { sessionID, setup } from "./fixture"

/** Runs against a real Session service over a fresh database, with the test Session inserted. */
const run = <A, E>(effect: Effect.Effect<A, E, Session.Service | Scope.Scope>) => {
  const directory = AbsolutePath.make(realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-session-map-"))))
  const layer = AppNodeBuilder.build(
    LayerNode.group([
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
  return Effect.runPromise(
    setup(directory, []).pipe(Effect.andThen(effect), Effect.scoped, Effect.provide(layer)) as Effect.Effect<A, E>,
  )
}

const metadata = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return (yield* sessions.get(sessionID)).metadata
})

// Dispatch regression guard (v1 session-map.test.ts): the SDK conversation a Session resumes is persisted.
describe("SdkSessionMap persistence", () => {
  test("write persists the entry on the Session and read returns it", async () => {
    const stored = await run(
      SdkSessionMap.write(sessionID, { uuid: "uuid-1", cwd: "/repo" }).pipe(Effect.andThen(metadata)),
    )
    expect(stored?.[SdkSessionMap.KEY]).toEqual({ sessionID, uuid: "uuid-1", cwd: "/repo" })
    expect(SdkSessionMap.read({ id: sessionID, metadata: stored })).toEqual({ uuid: "uuid-1", cwd: "/repo" })
  })

  test("a new conversation overwrites the old one", async () => {
    const stored = await run(
      SdkSessionMap.write(sessionID, { uuid: "old", cwd: "/repo" }).pipe(
        Effect.andThen(SdkSessionMap.write(sessionID, { uuid: "new", cwd: "/repo/sub" })),
        Effect.andThen(metadata),
      ),
    )
    expect(SdkSessionMap.read({ id: sessionID, metadata: stored })).toEqual({ uuid: "new", cwd: "/repo/sub" })
  })

  test("write and remove keep other metadata, such as the claude.ai bridge mapping", async () => {
    const bridge = { codeSessionID: "cse_1", mark: "msg_1" }
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* sessions.setMetadata({ sessionID, metadata: { "dispatch.bridge": bridge } })
        yield* SdkSessionMap.write(sessionID, { uuid: "uuid-1", cwd: "/repo" })
        const written = yield* metadata
        yield* SdkSessionMap.remove(sessionID)
        return { written, removed: yield* metadata }
      }),
    )
    expect(result.written).toEqual({
      "dispatch.bridge": bridge,
      [SdkSessionMap.KEY]: { sessionID, uuid: "uuid-1", cwd: "/repo" },
    })
    expect(result.removed).toEqual({ "dispatch.bridge": bridge })
    expect(SdkSessionMap.read({ id: sessionID, metadata: result.removed })).toBeUndefined()
  })

  test("remove on a Session without an entry is a no-op", async () => {
    expect(await run(SdkSessionMap.remove(sessionID).pipe(Effect.andThen(metadata)))).toBeUndefined()
  })
})
