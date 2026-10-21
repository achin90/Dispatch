import { afterEach, expect, test } from "bun:test"
import { DispatchRpc } from "../../src/feature-plugins/dispatch/rpc"
import { createApi, json } from "../fixture/tui-client"

afterEach(() => DispatchRpc.reset())

function server(handler: (url: URL, body: unknown) => Response) {
  const calls: { path: string; directory: string | null; body: unknown }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const body = await request.json().catch(() => undefined)
    calls.push({ path: url.pathname, directory: url.searchParams.get("location[directory]"), body })
    return handler(url, body)
  }
  fetch.preconnect = () => {}
  return { api: createApi(fetch), calls }
}

test("calls /api/rpc/dispatch/<method> with the input and the target directory", async () => {
  const { api, calls } = server(() => json({ output: { additions: 3, deletions: 1, files: 2 } }))
  const stat = await DispatchRpc.call(api, "worktree.diffstat", { directory: "/repo-wt" }, "/repo-wt")
  expect(stat).toEqual({ additions: 3, deletions: 1, files: 2 })
  expect(calls).toEqual([
    { path: "/api/rpc/dispatch/worktree.diffstat", directory: "/repo-wt", body: { input: { directory: "/repo-wt" } } },
  ])
})

test("methods without input send no input field", async () => {
  const { api, calls } = server(() => json({ output: ["ses_a"] }))
  expect(await DispatchRpc.call(api, "session.remoteControlList", undefined)).toEqual(["ses_a"])
  expect(calls[0]).toEqual({ path: "/api/rpc/dispatch/session.remoteControlList", directory: null, body: {} })
})

test("a missing method degrades to undefined and is not called again", async () => {
  const { api, calls } = server(() =>
    json(
      { _tag: "RpcError", type: "rpc.method_not_found", message: "Unknown RPC method: dispatch.github.status" },
      { status: 400 },
    ),
  )
  expect(await DispatchRpc.optional(api, "github.status", undefined)).toBeUndefined()
  expect(DispatchRpc.isUnavailable("github.status")).toBe(true)
  expect(await DispatchRpc.optional(api, "github.status", undefined)).toBeUndefined()
  expect(calls).toHaveLength(1)
  await expect(DispatchRpc.call(api, "github.status", undefined)).rejects.toBeInstanceOf(DispatchRpc.UnavailableError)
})

test("other failures still reject without marking the method unavailable", async () => {
  const { api } = server(() =>
    json({ _tag: "RpcInternalError", type: "rpc.internal", message: "RPC call failed" }, { status: 500 }),
  )
  await expect(DispatchRpc.call(api, "github.pr", { branch: "b", cwd: "/r" })).rejects.toMatchObject({
    type: "rpc.internal",
  })
  expect(DispatchRpc.isUnavailable("github.pr")).toBe(false)
})
