export * as DispatchAgentsPlugin from "./agents.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/core/agent"
import { Effect } from "effect"

export const plan = Agent.ID.make("plan")
export const yolo = Agent.ID.make("yolo")
/** Retired agent, kept hidden so Sessions saved with it still load. */
export const assistant = Agent.ID.make("assistant")

/**
 * Dispatch's primary agents: `build` asks before shell and edits, and `yolo` runs everything. Plan mode is
 * removed.
 *
 * Runs after `opencode.agent` and `opencode.plan`, so the agent map's insertion order (which
 * `Agent.list()` keeps, default first) is build, yolo, then config agents.
 */
export const Plugin = define({
  id: "dispatch.agents",
  effect: Effect.fn("DispatchAgentsPlugin")(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      // Permission.evaluate takes the last matching rule, so these narrow the default `* allow`.
      editor.update(Agent.defaultID, (item) => {
        item.permissions.push(
          { action: "shell", resource: "*", effect: "ask" },
          { action: "edit", resource: "*", effect: "ask" },
        )
      })
      editor.update(yolo, (item) => {
        item.name = Agent.Name.make("Yolo")
        item.description = "Auto runs write, edit, and bash commands."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })
      // Core fails a Session whose agent no longer exists, so the retired `assistant` stays as a hidden copy of
      // yolo: out of the switcher, and its Sessions keep running.
      editor.update(assistant, (item) => {
        item.name = Agent.Name.make("Yolo")
        item.mode = "primary"
        item.hidden = true
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })
      editor.remove(plan)
    })
  }),
})
