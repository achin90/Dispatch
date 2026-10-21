import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { directory, json, worktree } from "../fixture/tui-client"

const worktreeDirectory = `${worktree}-fix`

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...extra,
})

const sessions = {
  ses_root: session("ses_root", { title: "Builder" }),
  ses_child: session("ses_child", { parentID: "ses_root" }),
  ses_wt: session("ses_wt", { title: "Fixer", location: { directory: worktreeDirectory } }),
}

const childRequest = {
  id: "per_child",
  sessionID: "ses_child",
  action: "shell",
  resources: ["rm -rf build"],
  metadata: {},
}

test("the dashboard surfaces a subagent's permission and replies to the session that asked", async () => {
  await using state = await tmpdir()
  // The agent list is plugin storage: <state>/<channel>/tui/plugin.dispatch.agents.json.
  await mkdir(path.join(state.path, "test", "tui"), { recursive: true })
  await Bun.write(
    path.join(state.path, "test", "tui", "plugin.dispatch.agents.json"),
    JSON.stringify({
      agents: [
        { id: "a1", name: "Builder", sessionID: "ses_root", createdAt: 0, directory },
        {
          id: "a2",
          name: "Fixer",
          sessionID: "ses_wt",
          createdAt: 0,
          directory: worktreeDirectory,
          worktree: { branch: "fix", directory: worktreeDirectory, sourceRepo: worktree },
        },
      ],
    }),
  )
  const replies: { path: string; body: unknown }[] = []
  const rpc: string[] = []
  await using app = await createAppFixture({
    width: 120,
    height: 30,
    state: state.path,
    fetch: async (url, request) => {
      const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/)
      if (url.pathname.startsWith("/api/rpc/")) {
        rpc.push(url.pathname)
        if (url.pathname === "/api/rpc/dispatch-bridge/session.remoteControlList") return json({ output: ["ses_wt"] })
        if (url.pathname === "/api/rpc/dispatch/worktree.diffstat")
          return json({ output: { additions: 7, deletions: 2, files: 3 } })
        return json({ _tag: "RpcError", type: "rpc.method_not_found", message: "missing" }, { status: 400 })
      }
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_root")
        return json({ data: [sessions.ses_child], cursor: {} })
      if (url.pathname === "/api/session" && url.searchParams.get("parentID"))
        return json({ data: [], cursor: {} })
      if (!match) return undefined
      const [, id, rest] = match
      if (!(id in sessions)) return undefined
      if (!rest) return json({ data: sessions[id as keyof typeof sessions] })
      if (rest === "/message") return json({ data: [], cursor: {} })
      if (rest === "/inbox") return json({ data: [] })
      if (rest === "/form") return json({ data: [] })
      if (rest === "/permission") return json({ data: id === "ses_child" ? [childRequest] : [] })
      if (rest.endsWith("/reply") && request.method === "POST") {
        replies.push({ path: url.pathname, body: await request.json() })
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  await app.ready

  // The child's pending shell command shows on its root agent's row, with the command.
  await app.waitForFrame((frame) => frame.includes("Approve (y/n)") && frame.includes("$ rm -rf build"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("Builder")
  // Mirrored to claude.ai, and the worktree group's diffstat from the dispatch RPC.
  expect(frame).toMatch(/◉ Fixer/)
  await app.waitForFrame((frame) => frame.includes("+7 -2 3 files"))

  // A permission raised in the worktree's own location arrives on the shared event feed.
  app.events.emit({
    id: "evt_wt",
    type: "permission.asked",
    created: 1,
    location: { directory: worktreeDirectory },
    data: { id: "per_wt", sessionID: "ses_wt", action: "edit", resources: ["src/a.ts"], metadata: {} },
  } as unknown as OpenCodeEvent)
  await app.waitForFrame((frame) => frame.split("\n").filter((line) => line.includes("Approve (y/n)")).length === 2)

  // y on the first row answers the child session, not the agent root.
  app.mockInput.pressKey("y")
  await app.waitFor(() => replies.length === 1)
  expect(replies[0]).toEqual({
    path: "/api/session/ses_child/permission/per_child/reply",
    body: { decision: "once" },
  })

  // j then n rejects the worktree agent's request.
  app.mockInput.pressKey("j")
  app.mockInput.pressKey("n")
  await app.waitFor(() => replies.length === 2)
  expect(replies[1]).toEqual({ path: "/api/session/ses_wt/permission/per_wt/reply", body: { decision: "reject" } })

  // Enter opens the agent, and <leader>d comes back with the cursor still on it.
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => !frame.includes("new worktree"))
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("d")
  await app.waitForFrame((frame) => frame.includes("new worktree"))
  app.mockInput.pressKey("y")
  // The cursor is on Fixer, whose request was answered, so nothing else is sent.
  await Bun.sleep(50)
  expect(replies).toHaveLength(2)
})
