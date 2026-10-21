export * as DispatchGitHub from "./github.js"

import { Effect } from "effect"
import { DispatchProcess } from "../process.js"
import type { DispatchRpc } from "./definition.js"

const GH_TIMEOUT = 15_000

const gh = (args: readonly string[], cwd?: string) =>
  DispatchProcess.run("gh", args, { cwd, timeout: GH_TIMEOUT }).pipe(
    Effect.tap((result) =>
      result.code === 0 ? Effect.void : Effect.logWarning("gh failed", { args, cwd, stderr: result.stderr.trim() }),
    ),
  )

/** Whether the gh CLI is installed and logged in. */
export const status = () => gh(["auth", "status"]).pipe(Effect.map((result) => ({ authenticated: result.code === 0 })))

/** The most recent pull request whose head is `branch`, in any state. */
export const pr = Effect.fn("DispatchGitHub.pr")(function* (branch: string, cwd: string) {
  const result = yield* gh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,title,state,url,isDraft,baseRefName,statusCheckRollup,reviewDecision",
    ],
    cwd,
  )
  if (result.code !== 0) return null
  return parsePullRequests(result.stdout)
})

/** Pushes `head` (gh needs it on the remote), opens the pull request, and returns it. */
export const create = Effect.fn("DispatchGitHub.create")(function* (
  input: { readonly head: string; readonly base?: string; readonly title: string; readonly body?: string },
  cwd: string,
) {
  const push = yield* DispatchProcess.git(["push", "-u", "origin", input.head], cwd)
  if (push.code !== 0) return { error: `git push failed: ${summarize(push.stderr)}` }
  const created = yield* gh(
    [
      "pr",
      "create",
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body ?? "",
      ...(input.base ? ["--base", input.base] : []),
    ],
    cwd,
  )
  if (created.code !== 0) return { error: `gh pr create failed: ${summarize(created.stderr)}` }
  return (yield* pr(input.head, cwd)) ?? { error: "PR created but could not fetch it" }
})

export const merge = (number: number, cwd: string) =>
  gh(["pr", "merge", String(number), "--merge"], cwd).pipe(Effect.map((result) => result.code === 0))

export function parsePullRequests(stdout: string): DispatchRpc.PullRequest | null {
  const items: unknown = JSON.parse(stdout || "[]")
  const raw = Array.isArray(items) ? items.find((item): item is Record<string, unknown> => !!item) : undefined
  if (!raw) return null
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    state: raw.state === "MERGED" || raw.state === "CLOSED" ? raw.state : "OPEN",
    url: String(raw.url ?? ""),
    draft: raw.isDraft === true,
    base: typeof raw.baseRefName === "string" ? raw.baseRefName : "",
    checks: deriveChecks(raw.statusCheckRollup),
    review:
      raw.reviewDecision === "APPROVED" ||
      raw.reviewDecision === "CHANGES_REQUESTED" ||
      raw.reviewDecision === "REVIEW_REQUIRED"
        ? raw.reviewDecision
        : "",
  }
}

/** One status for a PR's check rollup: any failure fails, anything running is pending. */
export function deriveChecks(rollup: unknown): DispatchRpc.PullRequest["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none"
  const states = rollup.map((check: Record<string, unknown>) =>
    String(check?.conclusion || check?.status || "").toUpperCase(),
  )
  if (states.some((state) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(state))) return "fail"
  if (states.some((state) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING"].includes(state))) return "pending"
  if (states.every((state) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state))) return "pass"
  return "pending"
}

/** The first line that describes the failure, skipping git's "failed to push some refs" wrapper. */
function summarize(stderr: string) {
  const lines = stderr.split("\n").filter(Boolean)
  const detail = lines.find(
    (line) => (line.includes("ERROR") || line.startsWith("error:")) && !line.includes("failed to push some refs"),
  )
  return detail?.replace(/^error:\s*/, "").trim() ?? lines.pop() ?? "unknown error"
}
