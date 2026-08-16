import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { WithInstance } from "@/project/with-instance"
import { Session } from "@/session/session"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

// AppRuntime.runPromise attaches the surrounding WithInstance.provide context,
// which a bare Effect.runPromise cannot do (no InstanceRef → InstanceState dies).
function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return AppRuntime.runPromise(fx)
}

function createSession(directory: string, input?: Session.CreateInput) {
  return WithInstance.provide({
    directory,
    fn: () => runSession(Session.Service.use((svc) => svc.create(input))),
  })
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// ---------------------------------------------------------------------------
// Session-scoped routes run in the session's own instance — Dispatch guard
//
// Dispatch supports worktree agent sessions: a session created in directory A
// while the TUI (and therefore the request) is rooted in directory B. The
// HttpApi session handler group resolves each session's stored directory and
// runs the handler inside THAT instance (the `sessionInstance` /
// `withSessionInstance` pair in
// src/server/routes/instance/httpapi/handlers/session.ts, which wraps abort,
// init, summarize, command, shell, deleteMessage, prompt, promptAsync and
// lastResponse).
//
// Upstream opencode has no such redirection — handlers just run in the
// requester's instance. If a merge drops it, prompts and shell commands
// silently execute against the wrong directory (wrong files, wrong system
// prompt) while still returning 200 with plausible output. It fails silently,
// so these tests assert through the HTTP API only: they must stay meaningful
// no matter how the server internals are restructured.
// ---------------------------------------------------------------------------

describe("session routes run in the session's directory", () => {
  test("shell route executes in the session's directory, not the requester's", async () => {
    await using dirA = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using dirB = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    // Session is created in dir A, so dir A is its stored directory.
    const session = await createSession(dirA.path, { title: "agent-session" })

    // The request comes from an instance rooted at dir B.
    const response = await app().request(`/session/${session.id}/shell`, {
      method: "POST",
      headers: { "x-opencode-directory": dirB.path, "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", command: "pwd && touch marker.txt" }),
    })

    expect(response.status).toBe(200)
    const message = (await response.json()) as {
      info: { path: { cwd: string; root: string } }
      parts: { type: string; state?: { status: string; output?: string } }[]
    }

    // The assistant message records the instance the work ran in.
    expect(message.info.path.cwd).toBe(dirA.path)
    expect(message.info.path.root).toBe(dirA.path)

    // ...and the process itself really ran there.
    const tool = message.parts.find((part) => part.type === "tool")
    expect(tool?.state?.status).toBe("completed")
    expect(tool?.state?.output?.trim()).toBe(dirA.path)

    // Side effects land in dir A, never in the requesting instance's dir B.
    expect(await exists(path.join(dirA.path, "marker.txt"))).toBe(true)
    expect(await exists(path.join(dirB.path, "marker.txt"))).toBe(false)
  }, 30_000)

  test("abort route succeeds for a session owned by another directory", async () => {
    await using dirA = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using dirB = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const session = await createSession(dirA.path, {})

    // abort is one of the redirected handlers; resolving dir A's instance must
    // not make the route fail when the caller is rooted somewhere else.
    const response = await app().request(`/session/${session.id}/abort`, {
      method: "POST",
      headers: { "x-opencode-directory": dirB.path },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
  }, 30_000)
})
