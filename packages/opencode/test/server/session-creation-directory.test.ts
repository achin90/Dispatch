import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
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

    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "test" }),
    })

    expect(session.directory).toBe(tmp.path)
  })

  test("sessions in different directories store different directories", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const sessionA = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({ title: "agent-a" }),
    })

    const sessionB = await Instance.provide({
      directory: dirB.path,
      fn: () => Session.create({ title: "agent-b" }),
    })

    expect(sessionA.directory).toBe(dirA.path)
    expect(sessionB.directory).toBe(dirB.path)
    expect(sessionA.directory).not.toBe(sessionB.directory)
  })

  test("session.get preserves directory from creation", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    // Create in dir A
    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({ title: "worktree-agent" }),
    })

    // Retrieve from dir B context — Session.get should still return dir A
    const retrieved = await Instance.provide({
      directory: dirB.path,
      fn: () => Session.get(session.id),
    })

    expect(retrieved.directory).toBe(dirA.path)
  })

  test("session directory survives across instance contexts", async () => {
    await using worktree = await tmpdir({ git: true })
    await using tui = await tmpdir({ git: true })

    // Simulate: agent creates session in worktree directory
    const agent = await Instance.provide({
      directory: worktree.path,
      fn: () => Session.create({ title: "worktree-session" }),
    })

    // Simulate: TUI reads session from its own directory
    const fromTui = await Instance.provide({
      directory: tui.path,
      fn: () => Session.get(agent.id),
    })

    // The session must still reference the worktree, not the TUI
    expect(fromTui.directory).toBe(worktree.path)
    expect(fromTui.directory).not.toBe(tui.path)
  })
})
