import type { Plugin } from "@opencode/plugin/tui"
import { DispatchModel } from "./model"

/** The dashboard's stores. Storage memoizes by key, so every caller shares one live copy. */
export function dispatchState(context: Plugin.Context) {
  const [agents, updateAgents] = context.storage.store(DispatchModel.AGENTS_KEY, {
    initial: DispatchModel.emptyAgents(),
  })
  const [summaries, updateSummaries] = context.storage.store(DispatchModel.SUMMARIES_KEY, {
    initial: DispatchModel.emptySummaries(),
  })
  const [state, setState] = context.storage.memory(DispatchModel.STATE_KEY, { initial: DispatchModel.emptyState() })
  return { agents, updateAgents, summaries, updateSummaries, state, setState }
}

export type DispatchState = ReturnType<typeof dispatchState>
