export * as DispatchRpc from "./rpc"

import type { OpenCodeClient, RpcCallInput } from "@opencode/client"

// Dispatch's server plugins register two RPCs: `dispatch` (packages/dispatch/src/rpc/definition.ts)
// and `dispatch-bridge` for claude.ai mirroring (packages/dispatch/src/bridge/rpc.ts). Each call is
// `POST /api/rpc/<id>/<method>?location[directory]=<dir>` with `{ input }`. The TUI does not import
// packages/dispatch (it would pull server code into the client bundle), so the shapes are restated
// here; keep them in step with those definitions.

export const ID = "dispatch"
export const BRIDGE_ID = "dispatch-bridge"

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
  "gitRepos.list": { input: { root?: string; query?: string }; output: { repos: string[] } }
  "github.status": { input: {}; output: { authenticated: boolean } }
  "github.pr": { input: { branch: string; cwd?: string }; output: PullRequest | null }
  "github.createPr": {
    input: { head: string; base?: string; title: string; body?: string; cwd?: string }
    output: PullRequest | { error: string }
  }
  "github.mergePr": { input: { number: number; cwd?: string }; output: boolean }
  "worktree.info": { input: { directory?: string }; output: WorktreeInfo | null }
  "worktree.diff": { input: { directory?: string }; output: { diff: string } }
  "worktree.diffstat": { input: { directory?: string }; output: DiffStat }
  "session.lastResponse": { input: { sessionID: string }; output: LastResponse }
  "mcp.health": { input: {}; output: boolean }
  "migration.sync": { input: {}; output: string[] }
  // dispatch-bridge
  "session.remoteControl": { input: { sessionID: string }; output: { codeSessionID: string } }
  "session.remoteControlStop": { input: { sessionID: string }; output: boolean }
  "session.remoteControlList": { input: {}; output: string[] }
}

const BRIDGE_METHODS = new Set<string>(["session.remoteControl", "session.remoteControlStop", "session.remoteControlList"])

/** The RPC id that serves a method. */
export function rpcID(method: Method) {
  return BRIDGE_METHODS.has(method) ? BRIDGE_ID : ID
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
      rpcID: rpcID(method),
      method,
      // SAFETY: Every input in the method table is a plain JSON object.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      input: input as RpcCallInput["input"],
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
