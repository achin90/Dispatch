export * as DispatchCommandsPlugin from "./commands.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import PROMPT_DEEP_REVIEW from "./command/deep-review.txt"
import PROMPT_MERGE from "./command/merge.txt"

export const commands = [
  {
    name: "deepReview",
    description: "multi-agent code review for bugs and CLAUDE.md/AGENTS.md compliance",
    template: PROMPT_DEEP_REVIEW,
  },
  {
    name: "merge",
    description: "rebase and merge current worktree branch into parent",
    template: PROMPT_MERGE,
  },
] as const

/** `/deepReview` and `/merge`, built like the stock `/init` and `/review` commands. */
export const Plugin = define({
  id: "dispatch.commands",
  effect: Effect.fn("DispatchCommandsPlugin")(function* (ctx) {
    yield* ctx.command.transform((editor) => {
      for (const command of commands)
        editor.add({
          name: command.name,
          description: command.description,
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: render(command.template, input.prompt.text),
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        })
    })
  }),
})

/** Same rule as core's command plugin: `$ARGUMENTS` is replaced, otherwise the arguments follow. */
export function render(template: string, input: string) {
  const value = input.trim()
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => value)
  return [template, value].filter(Boolean).join("\n\n")
}
