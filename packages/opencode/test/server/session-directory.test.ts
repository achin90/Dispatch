import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session/session"
import { withSessionInstance } from "../../src/server/routes/instance/session"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

// ---------------------------------------------------------------------------
// withSessionInstance — Dispatch regression guard
//
// Upstream calls SessionPrompt methods directly without directory context.
// Dispatch wraps them with withSessionInstance so agent sessions running in
// worktree directories resolve paths correctly. These tests ensure the
// wrapper survives upstream merges.
// ---------------------------------------------------------------------------

describe("withSessionInstance", () => {
  test("runs callback in session directory context", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    // Create session in dir A — stores dirA as the session's directory
    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => svc.create({ title: "agent-session" }),
    })

    // From dir B, use withSessionInstance — it should provide dir A
    const resolved = await Instance.provide({
      directory: dirB.path,
      fn: () =>
        run(
          withSessionInstance(session.id, async () => {
            return Instance.directory
          }),
        ),
    })

    expect(resolved).toBe(dirA.path)
  })

  test("abort route returns success through withSessionInstance", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => svc.create({}),
    })

    // Start server in dir B and call abort on the session from dir A.
    // The route uses withSessionInstance, which resolves to dirA.
    // If withSessionInstance is broken, the route would fail.
    await Instance.provide({
      directory: dirB.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })
        expect(res.status).toBe(200)
      },
    })
  })
})
