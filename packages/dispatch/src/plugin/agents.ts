export * as DispatchAgentsPlugin from "./agents.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/core/agent"
import { Effect } from "effect"
import PROMPT_ASSISTANT from "./agent/assistant.txt"

export const plan = Agent.ID.make("plan")
export const yolo = Agent.ID.make("yolo")
export const assistant = Agent.ID.make("assistant")

/**
 * Dispatch's primary agents: `build` asks before shell and edits, `yolo` runs everything, and
 * `assistant` runs everything with an autonomous-teammate prompt. Plan mode is removed.
 *
 * Runs after `opencode.agent` and `opencode.plan`, so the agent map's insertion order (which
 * `Agent.list()` keeps, default first) is build, yolo, assistant, then config agents.
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
      editor.update(assistant, (item) => {
        item.name = Agent.Name.make("Assistant")
        item.description = "Autonomous assistant. Auto-runs tools, uses the Devin wiki, and double-checks answers."
        item.mode = "primary"
        item.system = PROMPT_ASSISTANT
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })
      // The user replaced plan mode with `assistant`; its plugin hooks only act on this agent.
      editor.remove(plan)
    })
  }),
})
