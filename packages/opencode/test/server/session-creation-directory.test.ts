import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { WithInstance } from "@/project/with-instance"
import { Effect } from "effect"
import { Session as SessionNs } from "../../src/session/session"
import type { SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// AppRuntime.runPromise attaches the surrounding WithInstance.provide context,
// which a bare Effect.runPromise cannot do (no InstanceRef → InstanceState dies).
function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return AppRuntime.runPromise(fx)
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  get(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.get(id)))
  },
}

afterEach(async () => {
  await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
})

// ---------------------------------------------------------------------------
// Session creation directory — Dispatch regression guard
//
// Agent sessions must store the directory they were created in (the worktree
// directory). When retrieved later, the session's directory must match, NOT
// the TUI's startup directory. This is the foundation for withSessionDirectory.
// ---------------------------------------------------------------------------

describe("session creation directory", () => {
  test("session stores its creation directory", async () => {
    await using tmp = await tmpdir({ git: true })

    const session = await WithInstance.provide({
      directory: tmp.path,
      fn: () => svc.create({ title: "test" }),
    })

    expect(session.directory).toBe(tmp.path)
  })

  test("sessions in different directories store different directories", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const sessionA = await WithInstance.provide({
      directory: dirA.path,
      fn: () => svc.create({ title: "agent-a" }),
    })

    const sessionB = await WithInstance.provide({
      directory: dirB.path,
      fn: () => svc.create({ title: "agent-b" }),
    })

    expect(sessionA.directory).toBe(dirA.path)
    expect(sessionB.directory).toBe(dirB.path)
    expect(sessionA.directory).not.toBe(sessionB.directory)
  })

  test("session.get preserves directory from creation", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    // Create in dir A
    const session = await WithInstance.provide({
      directory: dirA.path,
      fn: () => svc.create({ title: "worktree-agent" }),
    })

    // Retrieve from dir B context — svc.get should still return dir A
    const retrieved = await WithInstance.provide({
      directory: dirB.path,
      fn: () => svc.get(session.id),
    })

    expect(retrieved.directory).toBe(dirA.path)
  })

  test("session directory survives across instance contexts", async () => {
    await using worktree = await tmpdir({ git: true })
    await using tui = await tmpdir({ git: true })

    // Simulate: agent creates session in worktree directory
    const agent = await WithInstance.provide({
      directory: worktree.path,
      fn: () => svc.create({ title: "worktree-session" }),
    })

    // Simulate: TUI reads session from its own directory
    const fromTui = await WithInstance.provide({
      directory: tui.path,
      fn: () => svc.get(agent.id),
    })

    // The session must still reference the worktree, not the TUI
    expect(fromTui.directory).toBe(worktree.path)
    expect(fromTui.directory).not.toBe(tui.path)
  })
})
