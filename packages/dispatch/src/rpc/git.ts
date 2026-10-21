export * as DispatchGit from "./git.js"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { DispatchProcess } from "../process.js"
import type { DispatchRpc } from "./definition.js"

/**
 * Git repositories under `root` (default: home), for the dashboard's repo picker. Skips hidden
 * directories, symlinks and node_modules, and does not descend into a repository.
 */
export const repos = (input: { readonly root?: string; readonly query?: string }) =>
  Effect.promise(async () => {
    const needle = input.query?.toLowerCase()
    const found: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined)
      if (!entries) return
      if (entries.some((entry) => entry.name === ".git")) {
        if (!needle || path.basename(dir).toLowerCase().includes(needle)) found.push(dir)
        return
      }
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              !entry.isSymbolicLink() &&
              !entry.name.startsWith(".") &&
              entry.name !== "node_modules",
          )
          .map((entry) => walk(path.join(dir, entry.name))),
      )
    }
    await walk(input.root || os.homedir())
    return { repos: found.toSorted() }
  })

/** The linked worktree at `directory`: its branch and the repository it was created from. */
export const worktree = (directory: string) =>
  Effect.promise(async (): Promise<DispatchRpc.WorktreeInfo | null> => {
    const dir = directory.replace(/\/+$/, "")
    const content = await fs.readFile(path.join(dir, ".git"), "utf8").catch(() => undefined)
    if (!content?.startsWith("gitdir:")) return null
    const gitdir = content.replace("gitdir:", "").trim()
    const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir)
    const head = await fs.readFile(path.join(resolved, "HEAD"), "utf8").catch(() => "")
    const branch = head.startsWith("ref:")
      ? head
          .replace("ref:", "")
          .trim()
          .replace(/^refs\/heads\//, "")
      : path.basename(dir)
    // A linked worktree's gitdir is <source>/.git/worktrees/<name>.
    const source = /^(.+)\/\.git\/worktrees\//.exec(resolved)
    return { name: path.basename(dir), branch, directory: dir, sourceRepo: source ? source[1] : path.dirname(resolved) }
  })

/** `git diff HEAD`; empty when the directory is not a repository. */
export const diff = (directory: string) =>
  DispatchProcess.git(["diff", "HEAD"], directory).pipe(
    Effect.map((result) => ({ diff: result.code === 0 ? result.stdout : "" })),
  )

/** `git diff HEAD --numstat` totals. Binary files (`-` counts) are skipped, as in v1. */
export const diffstat = (directory: string) =>
  DispatchProcess.git(["diff", "HEAD", "--numstat"], directory).pipe(
    Effect.map((result) => parseNumstat(result.code === 0 ? result.stdout : "")),
  )

export function parseNumstat(text: string): DispatchRpc.DiffStat {
  const lines = text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 3 && !isNaN(parseInt(parts[0], 10)) && !isNaN(parseInt(parts[1], 10)))
  return {
    additions: lines.reduce((sum, parts) => sum + parseInt(parts[0], 10), 0),
    deletions: lines.reduce((sum, parts) => sum + parseInt(parts[1], 10), 0),
    files: new Set(lines.map((parts) => parts[2])).size,
  }
}
