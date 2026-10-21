import { SessionID } from "@opencode/schema/session-id"
import type { useClient } from "../../context/client"
import type { useData } from "../../context/data"
import type { useLocal } from "../../context/local"
import { DispatchModel } from "./model"
import { DispatchRpc } from "./rpc"
import type { DispatchState } from "./state"

/** Host services agent creation needs. Shared by the dashboard and the Jarvis voice commands. */
export type CreateHost = {
  client: ReturnType<typeof useClient>
  data: ReturnType<typeof useData>
  local: ReturnType<typeof useLocal>
  store: DispatchState
  /** Launch directory; relative agent directories resolve against it. */
  root: string
}

/** Creates the agent's session and inserts it into the dashboard list next to its directory group. */
export async function createAgent(
  host: CreateHost,
  input: { name: string; directory: string; worktree?: DispatchModel.AgentEntry["worktree"] },
) {
  const createdAt = Date.now()
  const id = SessionID.create()
  const agent = host.local.agent.current()?.id
  const model = host.local.model.selection()
  // The agent stamp goes in at creation only: later metadata writes would race the runner's own.
  const info = await host.client.api.session.create({
    id,
    title: input.name,
    location: { directory: input.directory },
    ...(agent ? { agent } : {}),
    ...(model ? { model: { providerID: model.providerID, id: model.modelID, variant: model.variant } } : {}),
    metadata: DispatchModel.agentMetadata({ name: input.name, createdAt, worktree: input.worktree }, id),
  })
  host.data.session.remember(info)
  const entry: DispatchModel.AgentEntry = {
    id: crypto.randomUUID(),
    name: input.name,
    sessionID: info.id,
    createdAt,
    directory: input.directory,
    ...(input.worktree ? { worktree: input.worktree } : {}),
  }
  const inserted = DispatchModel.insertAgent(host.store.agents.agents, entry, host.root)
  await host.store.updateAgents((draft) => {
    draft.agents = DispatchModel.insertAgent(draft.agents, entry, host.root).agents
  })
  return { entry, index: inserted.index }
}

/** An agent in `directory`, recording its worktree when the directory is one. */
export async function createDirectoryAgent(host: CreateHost, input: { name: string; directory: string }) {
  const worktree = await DispatchRpc.optional(
    host.client.api,
    "worktree.info",
    { directory: input.directory },
    input.directory,
  )
  return createAgent(host, {
    name: input.name,
    directory: input.directory,
    worktree: worktree
      ? { branch: worktree.branch, directory: worktree.directory, sourceRepo: worktree.sourceRepo }
      : undefined,
  })
}

/** A new worktree of `repository` named after the agent, with an agent working in it. */
export async function createWorktreeAgent(host: CreateHost, input: { name: string; repository: string }) {
  const project = await host.client.api.location.get({ location: { directory: input.repository } })
  const created = await host.client.api.worktree.create({ projectID: project.project.id, name: input.name })
  const directory = created.directory.replace(/\/+$/, "")
  host.store.setState((draft) => {
    draft.diffstats[directory] = { additions: 0, deletions: 0, files: 0 }
  })
  const info = await DispatchRpc.optional(host.client.api, "worktree.info", { directory }, directory)
  const branch =
    info?.branch ??
    (await host.client.api.vcs
      .get({ location: { directory } })
      .then((result) => result.data.branch.current)
      .catch(() => undefined)) ??
    input.name
  return createAgent(host, {
    name: input.name,
    directory,
    worktree: { branch, directory, sourceRepo: info?.sourceRepo ?? input.repository },
  })
}
