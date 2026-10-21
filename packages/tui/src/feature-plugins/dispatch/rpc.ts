export * as DispatchRpc from "./rpc"

import type { OpenCodeClient, RpcCallInput } from "@opencode/client"

// Dispatch's server plugin registers these under `Rpc.register({ id: "dispatch", ... })`, so each
// call is `POST /api/rpc/dispatch/<method>?location[directory]=<dir>`. The TUI cannot import the
// server definition, so the shapes are restated here; keep them in step with packages/dispatch.

export const ID = "dispatch"

export type PullRequest = {
  readonly number: number
  readonly title: string
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly url: string
  readonly draft: boolean
  readonly base: string
  readonly checks: "pass" | "fail" | "pending" | "none"
  readonly review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | ""
}

export type WorktreeInfo = {
  readonly name: string
  readonly branch: string
  readonly directory: string
  readonly sourceRepo: string
}

export type DiffStat = {
  readonly additions: number
  readonly deletions: number
  readonly files: number
}

export type LastResponse = {
  readonly text: string
  /** True when the server shortened a long reply with a model summary. */
  readonly summary: boolean
}

export type Methods = {
  "gitRepos.list": { input: { root: string; query?: string }; output: string[] }
  "github.status": { input: undefined; output: { authenticated: boolean } }
  "github.pr": { input: { branch: string; cwd: string }; output: PullRequest | null }
  "github.createPr": {
    input: { head: string; base?: string; title: string; body?: string; cwd: string }
    output: PullRequest | { error: string }
  }
  "github.mergePr": { input: { number: number; cwd: string }; output: boolean }
  "worktree.info": { input: { directory: string }; output: WorktreeInfo | null }
  "worktree.diff": { input: { directory: string }; output: string }
  "worktree.diffstat": { input: { directory: string }; output: DiffStat | null }
  "session.lastResponse": { input: { sessionID: string }; output: LastResponse }
  "session.remoteControlList": { input: undefined; output: string[] }
  "session.remoteControl": { input: { sessionID: string }; output: unknown }
  "session.remoteControlStop": { input: { sessionID: string }; output: unknown }
  "mcp.health": { input: undefined; output: unknown }
  // `config.update` only patches `shell`, so the advisor key needs its own write path.
  "advisor.get": { input: undefined; output: { advisor?: string } }
  "advisor.set": { input: { advisor: string }; output: unknown }
}

export type Method = keyof Methods

/** Thrown when the server has no Dispatch RPC, or no such method, so callers can degrade quietly. */
export class UnavailableError extends Error {
  constructor(readonly method: Method) {
    super(`Dispatch RPC is unavailable: ${method}`)
  }
}

const unavailable = new Set<Method>()

/** Methods that answered "unavailable" this session. Reset by a reconnect, since the server may have changed. */
export function isUnavailable(method: Method) {
  return unavailable.has(method)
}

export function reset() {
  unavailable.clear()
}

export async function call<M extends Method>(
  client: OpenCodeClient,
  method: M,
  input: Methods[M]["input"],
  directory?: string,
): Promise<Methods[M]["output"]> {
  if (unavailable.has(method)) throw new UnavailableError(method)
  const result = await client.rpc
    .call({
      rpcID: ID,
      method,
      // SAFETY: Every input in the method table is a plain JSON object.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      ...(input === undefined ? {} : { input: input as RpcCallInput["input"] }),
      ...(directory ? { location: { directory } } : {}),
    })
    .catch((error: unknown) => {
      if (!isMissing(error)) throw error
      unavailable.add(method)
      throw new UnavailableError(method)
    })
  // SAFETY: The method table above restates the server's output schema for this method.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return result.output as Methods[M]["output"]
}

/** Like `call`, but resolves `undefined` when the method is unavailable or fails. */
export function optional<M extends Method>(
  client: OpenCodeClient,
  method: M,
  input: Methods[M]["input"],
  directory?: string,
): Promise<Methods[M]["output"] | undefined> {
  return call(client, method, input, directory).catch(() => undefined)
}

// `rpc.unavailable` (no Dispatch RPC registered) and `rpc.method_not_found` come from core/src/rpc.ts.
export function isMissing(error: unknown) {
  if (!error || typeof error !== "object" || !("type" in error)) return false
  return error.type === "rpc.unavailable" || error.type === "rpc.method_not_found"
}
