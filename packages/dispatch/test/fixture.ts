import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, type Scope } from "effect"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SdkPermission } from "../src/runner/permission"

export const sessionID = SessionSchema.ID.make("ses_dispatch_test")
export const agent = Agent.ID.make("test")

/** A Location graph with the services the SDK callbacks use, standing on a fresh temp directory. */
export function location() {
  const directory = AbsolutePath.make(realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-location-"))))
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory,
      workspaceID: undefined,
      project: { id: Project.ID.global, directory, canonical: directory },
      vcs: undefined,
    }),
  )
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
    ]),
    [Location.node.replace(current)],
  )
  const run = <A, E>(effect: Effect.Effect<A, E, SdkPermission.Requirements | Scope.Scope | Database.Service>) =>
    Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<A, E>)
  return { directory, run }
}

/** Inserts the test Session and gives its agent the rules. */
export const setup = Effect.fn("fixture.setup")(function* (directory: string, rules: Permission.Ruleset) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory,
      title: "test",
      version: "test",
      agent,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(agent, (info) => {
      info.permissions = [...rules]
    }),
  )
})

/** Waits until the Location's Permission service holds a pending request. */
export const pending = Effect.fn("fixture.pending")(function* () {
  const permission = yield* Permission.Service
  for (let attempt = 0; attempt < 200; attempt++) {
    const [request] = yield* permission.list()
    if (request) return request
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error("no permission request arrived"))
})
