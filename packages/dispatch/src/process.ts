export * as DispatchProcess from "./process.js"

import { Effect } from "effect"

export interface Result {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs a command to completion and never fails: a missing binary or a timeout is a non-zero code,
 * so callers branch on `code` the way the v1 `git`/`gh` helpers did.
 */
export const run = (command: string, args: readonly string[], options: { cwd?: string; timeout?: number } = {}) =>
  Effect.promise(async (): Promise<Result> => {
    try {
      const proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeout,
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, stdout, stderr }
    } catch (error) {
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
    }
  })

export const git = (args: readonly string[], cwd: string) => run("git", args, { cwd })

/** The most useful line of a failed command's output. */
export const message = (result: Result, fallback: string) =>
  result.stderr.trim() || result.stdout.trim() || fallback
