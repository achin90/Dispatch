import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, on, onCleanup, onMount } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { useArgs } from "../../context/args"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTuiPaths } from "../../context/runtime"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { DialogAdvisor } from "./dialog-advisor"
import { DispatchModel } from "./model"
import { DispatchRpc } from "./rpc"
import { dispatchState, type DispatchState } from "./state"

const PR_POLL_MS = 300_000
const REMOTE_POLL_MS = 15_000

/** Diffstat per agent directory: the Dispatch RPC when present, else the v2 VCS working diff. */
export async function refreshDiffStats(context: Plugin.Context, store: DispatchState, only?: string) {
  const fallback = context.data.location.default().directory
  const directories = DispatchModel.groupAgents(store.agents.agents, fallback)
    .map((group) => group.directory)
    .filter((directory) => only === undefined || directory === only)
  await Promise.all(
    directories.map(async (directory) => {
      const stat =
        (await DispatchRpc.optional(context.client, "worktree.diffstat", { directory }, directory)) ??
        (await context.client.vcs
          .diff({ mode: "working", location: { directory } })
          .then((result) => DispatchModel.diffStat(result.data))
          .catch(() => undefined))
      if (!stat) return
      store.setState((draft) => {
        draft.diffstats[directory] = {
          additions: Number(stat.additions) || 0,
          deletions: Number(stat.deletions) || 0,
          files: Number(stat.files) || 0,
        }
      })
    }),
  )
}

/** PR status per worktree branch. Without the Dispatch GitHub RPC the PR column stays empty. */
export async function refreshPullRequests(context: Plugin.Context, store: DispatchState) {
  const status = await DispatchRpc.optional(context.client, "github.status", {})
  store.setState((draft) => {
    draft.github = status?.authenticated
  })
  if (!status?.authenticated) return
  const branches = new Map(
    store.agents.agents.flatMap((agent) => (agent.worktree ? [[agent.worktree.branch, agent.worktree.directory]] : [])),
  )
  await Promise.all(
    Array.from(branches, async ([branch, cwd]) => {
      const pr = await DispatchRpc.call(context.client, "github.pr", { branch, cwd }, cwd).catch((error: unknown) =>
        error instanceof DispatchRpc.UnavailableError ? undefined : ("error" as const),
      )
      if (pr === undefined) return
      store.setState((draft) => {
        draft.prs[branch] = pr
      })
    }),
  )
}

export async function refreshRemote(context: Plugin.Context, store: DispatchState) {
  const list = await DispatchRpc.optional(context.client, "session.remoteControlList", {})
  if (!list) return
  store.setState((draft) => {
    draft.remote = [...list]
  })
}

/**
 * Always mounted (app slot): keeps agent sessions synced across locations, fetches summaries when an
 * agent goes idle, polls PRs, and owns the Dispatch commands.
 */
export function DispatchWatcher(props: { context: Plugin.Context; route: string }) {
  const context = props.context
  const args = useArgs()
  const client = useClient()
  const data = useData()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const paths = useTuiPaths()
  const store = dispatchState(context)
  const dashboard = () => !args.noDashboard
  const isAgent = (sessionID: string) => store.agents.agents.some((agent) => agent.sessionID === sessionID)

  // A v1 install kept the list in `<state>/kv.json`; bring it over once while the v2 store is empty.
  onMount(() => {
    if (store.agents.agents.length > 0) return
    const file = path.join(paths.state, "kv.json")
    if (!existsSync(file)) return
    const legacy = DispatchModel.importLegacy(JSON.parse(readFileSync(file, "utf8")))
    if (legacy.agents.length === 0) return
    void store
      .updateAgents((draft) => {
        if (draft.agents.length === 0) draft.agents.push(...legacy.agents)
      })
      .then(() =>
        store.updateSummaries((draft) => {
          for (const [sessionID, summary] of Object.entries(legacy.summaries)) draft.bySession[sessionID] ??= summary
        }),
      )
      .then(() => {
        if (dashboard() && route.data.type === "home") context.ui.router.navigate({ type: "plugin", name: props.route })
      })
      .catch(toast.error)
  })

  // Once there is an agent, the dashboard is the home screen unless startup asked for a session or a
  // prompt. With none, launch keeps the stock composer; `<leader>d` or /dashboard opens it.
  onMount(() => {
    if (!dashboard() || route.data.type !== "home" || store.agents.agents.length === 0) return
    if (args.prompt || args.sessionID || args.continue || args.newSessionID) return
    context.ui.router.navigate({ type: "plugin", name: props.route })
  })

  // Pending permissions and forms already open in an agent's subagents only arrive by reading each
  // family member; later ones arrive as events from every location.
  createEffect(
    on(
      [() => store.agents.agents.map((agent) => agent.sessionID).join("\n"), () => client.connection.status()],
      ([ids, status]) => {
        if (status !== "connected" || !ids) return
        // A V1 client sharing the database may have written these sessions since the server imported.
        void DispatchRpc.optional(context.client, "migration.sync", {}).then(() => ids.split("\n").forEach(load))
      },
    ),
  )
  const load = (sessionID: string) => {
    void Promise.allSettled([
      data.session.sync(sessionID, { children: true }),
      data.session.message.sync(sessionID),
    ]).then(() =>
      Promise.allSettled(
        data.session
          .family(sessionID)
          .concat(sessionID)
          .flatMap((id) => [data.session.permission.sync(id), data.session.form.sync(id)]),
      ),
    )
  }

  createEffect(
    on(
      () => store.agents.agents.map((agent) => `${agent.sessionID}:${agent.worktree?.branch ?? ""}`).join("\n"),
      () => {
        void refreshDiffStats(context, store)
        void refreshPullRequests(context, store)
      },
    ),
  )
  const timer = setInterval(() => void refreshPullRequests(context, store), PR_POLL_MS)
  // Mirrors start and stop from claude.ai too, so the ◉ indicator polls.
  const remoteTimer = setInterval(() => void refreshRemote(context, store), REMOTE_POLL_MS)
  onCleanup(() => {
    clearInterval(timer)
    clearInterval(remoteTimer)
  })

  const fetching = new Set<string>()
  const summarize = (sessionID: string) => {
    if (fetching.has(sessionID)) return
    fetching.add(sessionID)
    void DispatchRpc.optional(context.client, "session.lastResponse", { sessionID })
      .then((result) => {
        if (!result?.text) return
        return store.updateSummaries((draft) => {
          draft.bySession[sessionID] = { text: result.text, ai: result.summary }
        })
      })
      .catch(() => {})
      .finally(() => fetching.delete(sessionID))
  }
  const settled = (sessionID: string) => {
    if (!isAgent(sessionID)) return
    summarize(sessionID)
    const agent = store.agents.agents.find((item) => item.sessionID === sessionID)
    if (agent)
      void refreshDiffStats(context, store, DispatchModel.agentDirectory(agent, data.location.default().directory))
  }
  const disposers = [
    context.data.on("server.connected", () => {
      DispatchRpc.reset()
      void refreshRemote(context, store)
    }),
    context.data.on("session.execution.started", (event) => {
      if (!store.summaries.bySession[event.data.sessionID]) return
      void store.updateSummaries((draft) => {
        delete draft.bySession[event.data.sessionID]
      })
    }),
    context.data.on("session.execution.succeeded", (event) => settled(event.data.sessionID)),
    context.data.on("session.execution.failed", (event) => settled(event.data.sessionID)),
    context.data.on("session.execution.interrupted", (event) => settled(event.data.sessionID)),
    context.data.on("session.deleted", (event) => {
      if (!isAgent(event.data.sessionID)) return
      void store.updateAgents((draft) => {
        draft.agents = draft.agents.filter((agent) => agent.sessionID !== event.data.sessionID)
      })
    }),
  ]
  onCleanup(() => disposers.forEach((dispose) => dispose()))
  void refreshRemote(context, store)

  const currentSession = () => (route.data.type === "session" ? data.session.root(route.data.sessionID) : undefined)
  const remote = async (action: "session.remoteControl" | "session.remoteControlStop") => {
    const sessionID = currentSession()
    dialog.clear()
    if (!sessionID) return toast.show({ message: "Open a session first", variant: "info" })
    await DispatchRpc.call(context.client, action, { sessionID })
      .then(() =>
        toast.show({
          message: action === "session.remoteControl" ? "Session mirrored to claude.ai" : "Stopped mirroring",
          variant: "success",
        }),
      )
      .catch((error: unknown) =>
        toast.show({
          message:
            error instanceof DispatchRpc.UnavailableError ? "This server cannot mirror sessions" : errorMessage(error),
          variant: "error",
        }),
      )
    await refreshRemote(context, store)
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.dashboard",
        title: "Agent dashboard",
        group: "Session",
        palette: true,
        slash: { name: "dashboard" },
        enabled: dashboard,
        run: () => {
          dialog.clear()
          const sessionID = currentSession()
          if (sessionID && isAgent(sessionID))
            store.setState((draft) => {
              draft.lastEntered = sessionID
            })
          context.ui.router.navigate({ type: "plugin", name: props.route })
        },
      },
      {
        id: "advisor.list",
        title: "Switch advisor model",
        group: "Agent",
        palette: true,
        slash: { name: "advisor" },
        run: () => dialog.replace(() => <DialogAdvisor />),
      },
      {
        id: "app.toggle.agent_summaries",
        title: store.summaries.visible ? "Hide agent summaries" : "Show agent summaries",
        group: "System",
        palette: true,
        run: () => {
          dialog.clear()
          void store
            .updateSummaries((draft) => {
              draft.visible = !draft.visible
            })
            .catch(toast.error)
        },
      },
      {
        id: "session.remote",
        title: "Start remote session",
        group: "Session",
        palette: true,
        slash: { name: "remote" },
        enabled: () => currentSession() !== undefined,
        run: () => void remote("session.remoteControl"),
      },
      {
        id: "session.remote.stop",
        title: "Stop remote session",
        group: "Session",
        palette: true,
        slash: { name: "remote-stop" },
        enabled: () => {
          const sessionID = currentSession()
          return sessionID !== undefined && store.state.remote.includes(sessionID)
        },
        run: () => void remote("session.remoteControlStop"),
      },
    ],
  }))

  return null
}
