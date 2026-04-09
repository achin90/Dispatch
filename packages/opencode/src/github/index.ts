import z from "zod"
import { execFile } from "child_process"
import { Log } from "../util/log"
import { git } from "../util/git"

export namespace GitHub {
  const log = Log.create({ service: "github" })

  export const PullRequest = z
    .object({
      number: z.number(),
      title: z.string(),
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      url: z.string(),
      draft: z.boolean(),
      base: z.string(),
      checks: z.enum(["pass", "fail", "pending", "none"]),
      review: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
    })
    .meta({ ref: "GitHubPullRequest" })

  export type PullRequest = z.infer<typeof PullRequest>

  export const Status = z
    .object({
      authenticated: z.boolean(),
    })
    .meta({ ref: "GitHubStatus" })

  export type Status = z.infer<typeof Status>

  function gh(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    log.info("gh", { args: ["gh", ...args].join(" "), cwd })
    return new Promise((resolve) => {
      execFile("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        log.info("gh result", { code, stdout: stdout?.trim(), stderr: stderr?.trim() })
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" })
      })
    })
  }

  export async function status(): Promise<Status> {
    const result = await gh(["auth", "status"])
    return { authenticated: result.code === 0 }
  }

  export async function pr(branch: string, cwd?: string): Promise<PullRequest | null> {
    const result = await gh(
      [
        "pr", "list",
        "--head", branch,
        "--state", "all",
        "--limit", "1",
        "--json", "number,title,state,url,isDraft,baseRefName,statusCheckRollup,reviewDecision",
      ],
      cwd,
    )
    if (result.code !== 0) {
      log.error("gh pr list failed", { branch, stderr: result.stderr })
      return null
    }
    const items: Record<string, unknown>[] = JSON.parse(result.stdout).filter(Boolean)
    if (!items.length) return null
    const raw = items[0]
    return {
      number: raw.number as number,
      title: raw.title as string,
      state: raw.state as PullRequest["state"],
      url: raw.url as string,
      draft: (raw.isDraft as boolean) ?? false,
      base: (raw.baseRefName as string) ?? "",
      checks: deriveChecks(raw.statusCheckRollup),
      review: (raw.reviewDecision as PullRequest["review"]) ?? "",
    }
  }

  function deriveChecks(rollup: unknown): PullRequest["checks"] {
    if (!rollup || !Array.isArray(rollup) || rollup.length === 0) return "none"
    const states = rollup.map((c: Record<string, unknown>) =>
      ((c.conclusion ?? c.status ?? "") as string).toUpperCase(),
    )
    if (states.some((s) => s === "FAILURE" || s === "ERROR" || s === "CANCELLED" || s === "TIMED_OUT")) return "fail"
    if (states.some((s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED" || s === "WAITING")) return "pending"
    if (states.every((s) => s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED")) return "pass"
    return "pending"
  }

  export async function create(
    input: { head: string; base?: string; title: string; body?: string },
    cwd?: string,
  ): Promise<PullRequest | null> {
    // Push branch to remote first — gh pr create requires the head branch to exist on GitHub
    if (cwd) {
      const push = await git(["push", "-u", "origin", input.head], { cwd })
      if (push.exitCode !== 0) {
        log.error("git push failed before pr create", { head: input.head, cwd, stderr: push.stderr.toString() })
        return null
      }
    }
    const args = ["pr", "create", "--head", input.head, "--title", input.title, "--body", input.body ?? ""]
    if (input.base) args.push("--base", input.base)
    const result = await gh(args, cwd)
    if (result.code !== 0) {
      log.error("gh pr create failed", { args, cwd, code: result.code, stdout: result.stdout, stderr: result.stderr })
      return null
    }
    return pr(input.head, cwd)
  }

  export async function merge(number: number, cwd?: string): Promise<boolean> {
    const result = await gh(["pr", "merge", String(number), "--merge"], cwd)
    if (result.code !== 0) {
      log.error("gh pr merge failed", { number, stderr: result.stderr })
      return false
    }
    return true
  }

  export async function open(number: number, cwd?: string): Promise<boolean> {
    const result = await gh(["pr", "view", String(number), "--web"], cwd)
    return result.code === 0
  }
}
