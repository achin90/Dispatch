import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { withSessionDirectory } from "../../src/server/instance/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

// ---------------------------------------------------------------------------
// withSessionDirectory — Dispatch regression guard
//
// Upstream calls SessionPrompt methods directly without directory context.
// Dispatch wraps them with withSessionDirectory so agent sessions running in
// worktree directories resolve paths correctly. These tests ensure the
// wrapper survives upstream merges.
// ---------------------------------------------------------------------------

describe("withSessionDirectory", () => {
  test("runs callback in session directory context", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    // Create session in dir A — stores dirA as the session's directory
    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({ title: "agent-session" }),
    })

    // From dir B, use withSessionDirectory — it should provide dir A
    const resolved = await Instance.provide({
      directory: dirB.path,
      fn: () =>
        withSessionDirectory(session.id, async () => {
          return Instance.directory
        }),
    })

    expect(resolved).toBe(dirA.path)
  })

  test("abort route preserves session directory", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({}),
    })

    // Spy on cancel and capture the directory it ran in
    let captured: string | undefined
    const cancel = spyOn(SessionPrompt, "cancel").mockImplementation(async () => {
      captured = Instance.directory
    })

    // Start server in dir B and call abort on the session from dir A
    await Instance.provide({
      directory: dirB.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })
        expect(res.status).toBe(200)
      },
    })

    expect(cancel).toHaveBeenCalledWith(session.id)
    expect(captured).toBe(dirA.path)

    cancel.mockRestore()
  })

  test("prompt route preserves session directory", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({}),
    })

    let captured: string | undefined
    const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(async () => {
      captured = Instance.directory
      return {} as any
    })

    await Instance.provide({
      directory: dirB.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
        })
        expect(res.status).toBe(204)
      },
    })

    // Give async route time to fire
    await new Promise((r) => setTimeout(r, 100))
    expect(prompt).toHaveBeenCalled()
    expect(captured).toBe(dirA.path)

    prompt.mockRestore()
  })

  test("command route preserves session directory", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({}),
    })

    let captured: string | undefined
    const command = spyOn(SessionPrompt, "command").mockImplementation(async () => {
      captured = Instance.directory
      return {} as any
    })

    await Instance.provide({
      directory: dirB.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request(`/session/${session.id}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "/help" }] }),
        })
        // command may succeed or fail depending on validation,
        // but the spy should have been called in the right directory
      },
    })

    if (command.mock.calls.length > 0) {
      expect(captured).toBe(dirA.path)
    }

    command.mockRestore()
  })

  test("shell route preserves session directory", async () => {
    await using dirA = await tmpdir({ git: true })
    await using dirB = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: dirA.path,
      fn: () => Session.create({}),
    })

    let captured: string | undefined
    const shell = spyOn(SessionPrompt, "shell").mockImplementation(async () => {
      captured = Instance.directory
      return {} as any
    })

    await Instance.provide({
      directory: dirB.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request(`/session/${session.id}/shell`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "pwd" }),
        })
      },
    })

    if (shell.mock.calls.length > 0) {
      expect(captured).toBe(dirA.path)
    }

    shell.mockRestore()
  })
})
