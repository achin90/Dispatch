export * as DispatchWorktreePlugin from "./worktree.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Worktree } from "@opencode/schema/worktree"
import { Effect } from "effect"
import { existsSync, realpathSync } from "fs"
import path from "path"
import { DispatchProcess } from "../process.js"

export const id = "dispatch"

const MAX_ATTEMPTS = 26

/**
 * Dispatch's default worktree strategy: a sibling of the source repository named
 * `<repo>-<slug>`, checked out on a new branch `<slug>` so it can back a pull request. Core picks
 * the slug (the requested name, or a random one) and passes it as the basename of `directory`.
 */
export const Plugin = define({
  id: "dispatch.worktree",
  effect: Effect.fn("DispatchWorktreePlugin")(function* (ctx) {
    yield* ctx.worktree.transform((editor) =>
      editor.add({
        id,
        create: (input) =>
          Effect.gen(function* () {
            const root = yield* toplevel(input.sourceDirectory)
            const target = yield* candidate(root, slugify(path.basename(input.directory)))
            const created = yield* DispatchProcess.git(
              ["worktree", "add", "-b", target.branch, "--", target.directory, input.branch ?? "HEAD"],
              root,
            )
            if (created.code !== 0)
              return yield* new Worktree.OperationError({
                message: DispatchProcess.message(created, "Failed to create git worktree"),
              })
            return { directory: target.directory }
          }),
        remove: (input) =>
          Effect.gen(function* () {
            const common = yield* commonDirectory(input.directory)
            const branch = (yield* entries(input.directory)).find((entry) =>
              same(entry.directory, input.directory),
            )?.branch
            const removed = yield* DispatchProcess.git(
              ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory],
              common,
            )
            if (removed.code !== 0) {
              const message = DispatchProcess.message(removed, "Failed to remove git worktree")
              return yield* new Worktree.OperationError({
                message,
                forceRequired: /contains modified or untracked files|is dirty/i.test(message),
              })
            }
            // v1 deleted the worktree's branch with it. The worktree is already gone, so a failure only warns.
            if (!branch) return
            const deleted = yield* DispatchProcess.git(["branch", "-D", branch], common)
            if (deleted.code !== 0)
              yield* Effect.logWarning("failed to delete worktree branch", {
                branch,
                error: DispatchProcess.message(deleted, "git branch -D failed"),
              })
          }),
        list: (directory) =>
          entries(directory).pipe(
            Effect.map((items) =>
              items.map((item, index) => ({ directory: item.directory, type: index === 0 ? "root" : "worktree" }) as const),
            ),
          ),
      }),
    )
  }),
})

/** A free `<parent>/<repo>-<slug>` directory and `<slug>` branch, suffixing `-2`, `-3`… on collision. */
export const candidate = Effect.fn("DispatchWorktree.candidate")(function* (root: string, slug: string) {
  const parent = path.dirname(root)
  const repo = path.basename(root)
  for (const attempt of Array.from({ length: MAX_ATTEMPTS }, (_, index) => index)) {
    const branch = attempt === 0 ? slug : `${slug}-${attempt + 1}`
    const directory = path.join(parent, `${repo}-${branch}`)
    if (existsSync(directory)) continue
    const exists = yield* DispatchProcess.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root)
    if (exists.code === 0) continue
    return { directory, branch }
  }
  return yield* new Worktree.OperationError({ message: `No free worktree name for ${slug}` })
})

/** Branch-safe form of a requested worktree name. */
export function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/\.{2,}/g, ".") || "worktree"
  )
}

const toplevel = Effect.fn("DispatchWorktree.toplevel")(function* (directory: string) {
  const result = yield* DispatchProcess.git(["rev-parse", "--show-toplevel"], directory)
  if (result.code !== 0)
    return yield* new Worktree.OperationError({ message: DispatchProcess.message(result, "Not a git repository") })
  return result.stdout.trim()
})

const commonDirectory = Effect.fn("DispatchWorktree.commonDirectory")(function* (directory: string) {
  const result = yield* DispatchProcess.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], directory)
  if (result.code !== 0)
    return yield* new Worktree.OperationError({ message: DispatchProcess.message(result, "Not a git repository") })
  return result.stdout.trim()
})

/** `git worktree list --porcelain`, main worktree first. */
const entries = Effect.fn("DispatchWorktree.entries")(function* (directory: string) {
  const result = yield* DispatchProcess.git(["worktree", "list", "--porcelain"], directory)
  if (result.code !== 0)
    return yield* new Worktree.OperationError({
      message: DispatchProcess.message(result, "Failed to read git worktrees"),
    })
  return parseWorktreeList(result.stdout)
})

export function parseWorktreeList(text: string) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n"))
    .flatMap((lines) => {
      const worktree = lines.find((line) => line.startsWith("worktree "))
      if (!worktree) return []
      const branch = lines.find((line) => line.startsWith("branch "))
      return [
        {
          directory: worktree.slice("worktree ".length).trim(),
          branch: branch?.slice("branch ".length).trim().replace(/^refs\/heads\//, ""),
        },
      ]
    })
}

const same = (left: string, right: string) => resolve(left) === resolve(right)

const resolve = (directory: string) => (existsSync(directory) ? realpathSync(directory) : path.resolve(directory))
