import path from "path"
import type { Plugin } from "@opencode/plugin/tui"
import type { PermissionRequest } from "@opencode/client"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useLocation } from "../../context/location"
import { useLocal } from "../../context/local"
import { useTheme, useThemes } from "../../context/theme"
import { useClipboard } from "../../context/clipboard"
import { usePathFormatter } from "../../context/path-format"
import { Keymap } from "../../context/keymap"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { Spinner } from "../../component/spinner"
import { PatchDiff } from "../../component/patch-diff"
import { Prompt } from "../../component/prompt"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import { permissionPresentation } from "../../util/permission"
import { createDirectoryAgent, createWorktreeAgent } from "./create"
import { DialogDirectorySelect } from "./dialog-directory-select"
import { DialogGitRepoSelect } from "./dialog-git-repo-select"
import { DispatchModel } from "./model"
import { DispatchRpc } from "./rpc"
import { dispatchState } from "./state"
import { refreshDiffStats, refreshPullRequests } from "./watch"

export const ROUTE = "dashboard"

export function Dashboard(props: { context: Plugin.Context }) {
  const context = props.context
  const client = useClient()
  const data = useData()
  const route = useRoute()
  const local = useLocal()
  const theme = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const paths = usePathFormatter()
  const keymap = Keymap.use()
  const leaderActive = Keymap.useLeaderActive()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const store = dispatchState(context)
  const root = () => data.location.default().directory

  const groups = createMemo(() => DispatchModel.groupAgents(store.agents.agents, root()))
  const flat = createMemo(() => groups().flatMap((group) => group.agents))
  const status = (agent: DispatchModel.AgentEntry) =>
    DispatchModel.agentStatus({
      root: agent.sessionID,
      family: data.session.family(agent.sessionID),
      permissions: (id) => data.session.permission.list(id),
      forms: (id) => data.session.form.list(id),
      running: (id) => data.session.status(id) === "running",
      messages: (id) => data.session.message.list(id),
    })

  // The cursor returns to the agent last opened from here.
  const start = untrack(() =>
    flat().findIndex((agent) => agent.sessionID === (store.state.lastEntered ?? store.state.selected)),
  )
  const [index, setIndex] = createSignal(Math.max(0, start))
  const selected = () => flat()[index()]
  createEffect(() => {
    if (index() >= flat().length && flat().length > 0) setIndex(flat().length - 1)
  })
  createEffect(() => {
    const sessionID = selected()?.sessionID
    store.setState((draft) => {
      draft.selected = sessionID
    })
  })
  const github = () => store.state.github === true

  const [busy, setBusy] = createSignal(false)
  const [promptOpen, setPromptOpen] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined

  function select(next: number) {
    if (flat().length === 0) return
    setIndex(next)
    const target = scroll?.getChildren().find((child) => child.id === `dispatch-agent-${next}`)
    if (!scroll || !target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + target.height)
    if (y < 0) scroll.scrollBy(y)
  }

  function save(mutation: (draft: DispatchModel.AgentsState) => void) {
    return store.updateAgents(mutation).catch(toast.error)
  }

  function open(agent: DispatchModel.AgentEntry) {
    store.setState((draft) => {
      draft.lastEntered = agent.sessionID
    })
    // Session tabs open a tab for every routed session, so this also focuses the agent's tab.
    route.navigate({ type: "session", sessionID: agent.sessionID })
    // If V1 wrote to this session since the server imported it, pull the new messages in.
    void DispatchRpc.optional(context.client, "migration.sync", {}).then((ids) => {
      if (ids?.includes(agent.sessionID)) return data.session.message.sync(agent.sessionID)
    })
  }

  // Session-scoped commands (terminal, diff) register once the session view mounts.
  function openThen(agent: DispatchModel.AgentEntry, command: string, label: string) {
    open(agent)
    const attempt = (remaining: number) => {
      const ready = route.data.type === "session" && context.keymap.commands().some((item) => item.id === command)
      if (ready) return context.keymap.dispatch(command)
      if (remaining === 0)
        return toast.show({ message: `${label} is not available for this session`, variant: "warning" })
      setTimeout(() => attempt(remaining - 1), 50)
    }
    setTimeout(() => attempt(40), 0)
  }

  const host = () => ({ client, data, local, store, root: root() })

  async function add() {
    const directory = await DialogDirectorySelect.show(dialog, "Select Directory", root())
    if (!directory) return dialog.clear()
    const name = await context.ui.dialog.prompt({ title: "New Agent", placeholder: "Agent name" })
    if (!name?.trim()) return
    const target = directory === "." ? root() : path.join(root(), directory)
    await createDirectoryAgent(host(), { name: name.trim(), directory: target })
      .then((created) => setIndex(created.index))
      .catch(toast.error)
  }

  async function addWorktree() {
    const repository = await DialogGitRepoSelect.show(dialog, "Select Source Repository", root())
    if (!repository) return dialog.clear()
    const name = await context.ui.dialog.prompt({
      title: "New Worktree Agent",
      placeholder: "Agent name (used as branch)",
    })
    if (!name?.trim()) return
    setBusy(true)
    toast.show({ message: "Creating worktree…", variant: "info" })
    await createWorktreeAgent(host(), { name: name.trim(), repository })
      .then((created) => setIndex(created.index))
      .catch((error: unknown) =>
        toast.show({ title: "Creating worktree failed", message: errorMessage(error), variant: "error" }),
      )
      .finally(() => setBusy(false))
  }

  async function remove(agent: DispatchModel.AgentEntry) {
    const ok = await context.ui.dialog.confirm({
      title: "Remove Agent",
      message: `Remove "${agent.name}" from the dashboard?`,
    })
    if (!ok) return
    await save((draft) => {
      draft.agents = draft.agents.filter((item) => item.id !== agent.id)
    })
  }

  async function purge(agent: DispatchModel.AgentEntry) {
    const directory = DispatchModel.agentDirectory(agent, root())
    const worktree =
      agent.worktree ?? (await DispatchRpc.optional(client.api, "worktree.info", { directory }, directory))
    if (!worktree) return toast.show({ message: "This agent is not in a worktree", variant: "info" })
    const ok = await context.ui.dialog.confirm({
      title: "Delete Worktree",
      message: `Delete worktree and all agents in ${paths.format(directory)}?`,
    })
    if (!ok) return
    setBusy(true)
    await (async () => {
      const project = await client.api.location.get({ location: { directory } })
      const request = { projectID: project.project.id, directory }
      const failure = await client.api.worktree.remove({ ...request, force: false }).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (failure) {
        if (!forceRequired(failure)) throw failure
        const force = await context.ui.dialog.confirm({
          title: "Delete worktree?",
          message: "This worktree has file changes. Delete it anyway?",
        })
        if (!force) return
        await client.api.worktree.remove({ ...request, force: true })
      }
      await save((draft) => {
        draft.agents = draft.agents.filter((item) => DispatchModel.agentDirectory(item, root()) !== directory)
      })
    })()
      .catch((error: unknown) =>
        toast.show({ title: "Failed to delete worktree", message: errorMessage(error), variant: "error" }),
      )
      .finally(() => setBusy(false))
  }

  function reply(agent: DispatchModel.AgentEntry, decision: "once" | "reject") {
    const current = status(agent)
    if (current.type !== "approve") return
    // Forms need their fields filled in, which the session view does.
    if (current.pending.type === "form") return open(agent)
    const request = current.pending.request
    // Reply to the session that asked: a subagent's request lives on its child session.
    void data.session.permission
      .reply({ sessionID: request.sessionID, requestID: request.id, decision })
      .catch(toast.error)
  }

  function copy(text: string, message: string) {
    void clipboard
      .write(text)
      .then(() => toast.show({ message, variant: "info" }))
      .catch(() => toast.show({ message: text, variant: "info" }))
  }

  function refresh() {
    DispatchRpc.reset()
    void refreshDiffStats(context, store)
    void refreshPullRequests(context, store)
    toast.show({ message: "Refreshing PR statuses…", variant: "info" })
  }

  async function propose(agent: DispatchModel.AgentEntry) {
    if (!agent.worktree) return toast.show({ message: "Pull requests need a worktree agent", variant: "info" })
    const worktree = agent.worktree
    const existing = store.state.prs[worktree.branch]
    if (existing && existing !== "error" && existing.state === "OPEN")
      return toast.show({ message: `PR #${existing.number} already exists`, variant: "info" })
    const title = await context.ui.dialog.prompt({ title: "Create Pull Request", placeholder: "PR title" })
    if (!title?.trim()) return
    const body = await context.ui.dialog.prompt({ title: "PR Description (optional)", placeholder: "PR description" })
    toast.show({ message: "Creating PR…", variant: "info" })
    const result = await DispatchRpc.call(
      client.api,
      "github.createPr",
      { head: worktree.branch, title: title.trim(), body: body ?? "", cwd: worktree.directory },
      worktree.directory,
    ).catch((error: unknown) => ({ error: errorMessage(error) }))
    if ("error" in result) return toast.show({ message: result.error, variant: "error" })
    store.setState((draft) => {
      draft.prs[worktree.branch] = result
    })
    toast.show({ message: `Created PR #${result.number}`, variant: "success" })
  }

  function pullRequest(agent: DispatchModel.AgentEntry) {
    const pr = agent.worktree ? store.state.prs[agent.worktree.branch] : undefined
    if (pr && pr !== "error") return pr
    toast.show({ message: "No PR for this branch", variant: "info" })
  }

  async function merge(agent: DispatchModel.AgentEntry) {
    const pr = pullRequest(agent)
    if (!pr || !agent.worktree) return
    const blocker = DispatchModel.mergeBlocker(pr)
    if (blocker) return toast.show({ message: blocker, variant: pr.state === "OPEN" ? "error" : "info" })
    const ok = await context.ui.dialog.confirm({ title: "Merge PR", message: `Merge PR #${pr.number} "${pr.title}"?` })
    if (!ok) return
    toast.show({ message: "Merging PR…", variant: "info" })
    const merged = await DispatchRpc.call(
      client.api,
      "github.mergePr",
      { number: pr.number, cwd: agent.worktree.directory },
      agent.worktree.directory,
    ).catch(() => false)
    if (!merged) return toast.show({ message: "Failed to merge PR", variant: "error" })
    toast.show({ message: `Merged PR #${pr.number}`, variant: "success" })
    void refreshPullRequests(context, store)
  }

  function run(action: DispatchModel.DashboardAction) {
    if (action.type === "add") return void add()
    if (action.type === "worktree") return void addWorktree()
    if (action.type === "refresh") return refresh()
    const agent = selected()
    if (!agent) return
    if (action.type === "move") return select((index() + action.delta + flat().length) % flat().length)
    if (action.type === "jump") return action.index < flat().length ? select(action.index) : undefined
    if (action.type === "open") return open(agent)
    if (action.type === "copy") return copy(DispatchModel.agentDirectory(agent, root()), "Copied path to clipboard")
    if (action.type === "remove") return void remove(agent)
    if (action.type === "purge") return void purge(agent)
    if (action.type === "diff") return openThen(agent, "diff.open", "The diff viewer")
    if (action.type === "terminal") return openThen(agent, "terminal.toggle", "The terminal pane")
    if (action.type === "approve") return reply(agent, "once")
    if (action.type === "deny") return reply(agent, "reject")
    if (action.type === "message") return setPromptOpen(true)
    if (action.type === "copyPr") {
      const pr = pullRequest(agent)
      return pr ? copy(pr.url, `Copied ${pr.url}`) : undefined
    }
    if (!github()) return
    if (action.type === "createPr") return void propose(agent)
    if (action.type === "mergePr") return void merge(agent)
  }

  // Keys only reach the dashboard when nothing else owns input: no dialog (which pushes the modal
  // mode), no inline prompt, no pending leader sequence, and no focused editor.
  onCleanup(
    keymap.intercept(
      "key",
      (input) => {
        if (busy() || promptOpen() || leaderActive()) return
        if (dialog.stack.length > 0 || keymap.mode.current() !== "base") return
        if (renderer.currentFocusedEditor) return
        const action = DispatchModel.dashboardAction(input.event)
        if (!action) return
        if (flat().length === 0 && action.type !== "add" && action.type !== "worktree") return
        input.consume()
        run(action)
      },
      { priority: 50 },
    ),
  )

  context.keymap.layer(() => ({
    enabled: promptOpen(),
    priority: 2,
    commands: [{ bind: "escape", title: "Dismiss prompt", group: "Dashboard", run: () => setPromptOpen(false) }],
  }))

  return (
    <box flexGrow={1} flexDirection="column">
      <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
        <box flexDirection="row" flexShrink={0}>
          <box width={4} flexShrink={0}>
            <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
              #
            </text>
          </box>
          <box width="30%" flexShrink={0}>
            <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
              Name
            </text>
          </box>
          <box width={18} flexShrink={0}>
            <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
              Status
            </text>
          </box>
          <box flexGrow={1} flexShrink={1} minWidth={0}>
            <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
              Activity
            </text>
          </box>
        </box>
        <Show
          when={flat().length > 0}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={theme.text.muted}>No agents yet. Press 'a' to create or 'w' for worktree.</text>
            </box>
          }
        >
          <scrollbox
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
            ref={(value: ScrollBoxRenderable) => (scroll = value)}
          >
            <For each={groups()}>
              {(group) => (
                <>
                  <GroupHeader context={context} directory={group.directory} agents={group.agents} />
                  <For each={group.agents}>
                    {(agent) => {
                      const position = createMemo(() => flat().indexOf(agent))
                      return (
                        <AgentRow
                          context={context}
                          agent={agent}
                          index={position()}
                          selected={position() === index()}
                          status={status(agent)}
                          remote={store.state.remote.includes(agent.sessionID)}
                          summary={store.summaries.visible ? store.summaries.bySession[agent.sessionID] : undefined}
                        />
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
      <Footer context={context} github={github()} />
      <Show when={promptOpen() ? selected() : undefined} keyed>
        {(agent) => (
          <InlinePrompt
            agent={agent}
            directory={DispatchModel.agentDirectory(agent, root())}
            width={Math.min(dimensions().width - 8, 120)}
            onClose={() => setPromptOpen(false)}
          />
        )}
      </Show>
    </box>
  )
}

function forceRequired(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) return false
  const data = error.data
  return !!data && typeof data === "object" && "forceRequired" in data && data.forceRequired === true
}

function GroupHeader(props: { context: Plugin.Context; directory: string; agents: DispatchModel.AgentEntry[] }) {
  const theme = useTheme()
  const store = dispatchState(props.context)
  const stat = () => store.state.diffstats[props.directory]
  const pr = () => {
    const branch = props.agents.find((agent) => agent.worktree?.branch)?.worktree?.branch
    return branch ? store.state.prs[branch] : undefined
  }
  const prColor = () => {
    const value = pr()
    if (!value || value === "error") return theme.text.base
    if (value.state === "MERGED") return theme.hue.accent[200]
    if (value.state === "CLOSED") return theme.text.feedback.error.base
    if (value.draft) return theme.text.base
    if (value.checks === "fail" || value.review === "CHANGES_REQUESTED") return theme.text.feedback.error.base
    if (value.review === "APPROVED" && value.checks === "pass") return theme.text.feedback.success.base
    return theme.text.base
  }
  return (
    <box paddingTop={1} flexDirection="row" flexShrink={0}>
      <text fg={theme.hue.accent[200]} attributes={TextAttributes.BOLD} overflow="hidden" wrapMode="none">
        {props.context.ui.format.path(props.directory)}
      </text>
      <Show when={stat()}>
        {(value) => (
          <text wrapMode="none">
            {"  "}
            <span style={{ fg: theme.text.feedback.success.base }}>+{value().additions}</span>{" "}
            <span style={{ fg: theme.text.feedback.error.base }}>-{value().deletions}</span>{" "}
            <span style={{ fg: theme.text.muted }}>
              {value().files} {value().files === 1 ? "file" : "files"}
            </span>
          </text>
        )}
      </Show>
      <Switch>
        <Match when={pr() === "error"}>
          <text fg={theme.text.muted}>{"  ?"}</text>
        </Match>
        <Match when={pr()}>
          {(value) => {
            const current = value()
            return current === "error" ? null : (
              <text fg={prColor()} overflow="hidden" wrapMode="none">
                {"  " + DispatchModel.prLabel(current)}
              </text>
            )
          }}
        </Match>
      </Switch>
    </box>
  )
}

function AgentRow(props: {
  context: Plugin.Context
  agent: DispatchModel.AgentEntry
  index: number
  selected: boolean
  status: DispatchModel.AgentStatus
  remote: boolean
  summary?: DispatchModel.AgentSummary
}) {
  const theme = useTheme()
  const fg = () => (props.selected ? theme.text.action.primary.focused : undefined)
  const statusColor = () =>
    fg() ??
    (props.status.type === "working"
      ? theme.text.feedback.success.base
      : props.status.type === "retrying"
        ? theme.text.feedback.error.base
        : theme.text.feedback.warning.base)
  const activity = () => (props.status.type === "working" ? props.status.activity : undefined)
  return (
    <box id={`dispatch-agent-${props.index}`} flexDirection="column" flexShrink={0}>
      <box flexDirection="row" backgroundColor={props.selected ? theme.background.action.primary.focused : undefined}>
        <box width={4} flexShrink={0}>
          <text fg={fg() ?? theme.text.muted}>{DispatchModel.hotkey(props.index)}</text>
        </box>
        <box width="30%" flexShrink={0}>
          <text
            fg={fg() ?? theme.text.base}
            attributes={props.selected ? TextAttributes.BOLD : undefined}
            overflow="hidden"
            wrapMode="none"
          >
            <Show when={props.remote}>
              <span style={{ fg: fg() ?? theme.text.feedback.success.base }}>◉ </span>
            </Show>
            {props.agent.name}
          </text>
        </box>
        <box width={18} flexShrink={0}>
          <Show
            when={props.status.type === "working"}
            fallback={<text fg={statusColor()}>{DispatchModel.STATUS_LABEL[props.status.type]}</text>}
          >
            <Spinner color={statusColor()}>{DispatchModel.STATUS_LABEL.working}</Spinner>
          </Show>
        </box>
        <box flexGrow={1} flexShrink={1} minWidth={0}>
          <text fg={fg() ?? theme.text.muted} overflow="hidden" wrapMode="none">
            {activity() ?? "-"}
          </text>
        </box>
      </box>
      <Switch>
        <Match when={props.status.type === "approve" ? props.status.pending : undefined}>
          {(pending) => {
            const current = pending()
            return current.type === "permission" ? (
              <PermissionDetail request={current.request} selected={props.selected} />
            ) : (
              <box paddingLeft={4}>
                <text fg={props.selected ? theme.text.base : theme.text.muted} overflow="hidden" wrapMode="none">
                  {`Form: ${current.form.title} (y opens it)`}
                </text>
              </box>
            )
          }}
        </Match>
        <Match when={props.summary}>
          {(summary) => (
            <box paddingLeft={4} maxHeight={4}>
              <text fg={theme.text.muted} wrapMode="word" overflow="hidden">
                {(summary().ai ? "Summary: " : "") + summary().text}
              </text>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  )
}

function PermissionDetail(props: { request: PermissionRequest; selected: boolean }) {
  const theme = useTheme()
  const themes = useThemes()
  const data = useData()
  const paths = usePathFormatter()
  // The tool call that asked carries the input and edit diff the request metadata may omit.
  const source = createMemo(() => {
    const tool = props.request.source
    const message = tool ? data.session.message.get(props.request.sessionID, tool.messageID) : undefined
    const part =
      message?.type === "assistant"
        ? message.content.find((item) => item.type === "tool" && item.id === tool?.id)
        : undefined
    if (part?.type !== "tool" || part.state.status === "streaming") return {}
    return { input: part.state.input, metadata: part.state.metadata }
  })
  const presentation = createMemo(() =>
    permissionPresentation(
      {
        action: props.request.action,
        resources: props.request.resources,
        metadata: props.request.metadata,
        input: source().input,
        toolMetadata: source().metadata,
      },
      paths.format,
    ),
  )
  const color = () => (props.selected ? theme.text.base : theme.text.muted)
  return (
    <box paddingLeft={4} maxHeight={10} flexShrink={0}>
      <Switch>
        <Match when={props.request.action === "edit" && presentation().diff}>
          {(diff) => (
            <box flexDirection="column">
              <text fg={color()} overflow="hidden" wrapMode="none">
                {presentation().title}
              </text>
              <scrollbox maxHeight={8} scrollbarOptions={{ visible: false }}>
                <PatchDiff
                  diff={diff()}
                  hunkFg={theme.diff.text.hunkHeader}
                  view="unified"
                  filetype={filetype(presentation().file)}
                  syntaxStyle={themes.currentSyntax()}
                  showLineNumbers={true}
                  width="100%"
                  wrapMode="word"
                  fg={theme.text.base}
                  addedBg={theme.diff.background.added}
                  removedBg={theme.diff.background.removed}
                  contextBg={theme.diff.background.context}
                  addedSignColor={theme.diff.highlight.added}
                  removedSignColor={theme.diff.highlight.removed}
                  lineNumberFg={theme.diff.lineNumber.text}
                  lineNumberBg={theme.diff.background.context}
                  addedLineNumberBg={theme.diff.lineNumber.background.added}
                  removedLineNumberBg={theme.diff.lineNumber.background.removed}
                />
              </scrollbox>
            </box>
          )}
        </Match>
        <Match when={props.request.action === "shell"}>
          <text fg={theme.text.base} wrapMode="word" overflow="hidden">
            {presentation().lines[0]?.startsWith("$ ")
              ? presentation().lines[0]
              : `$ ${props.request.resources[0] ?? ""}`}
          </text>
        </Match>
        <Match when={true}>
          <text fg={color()} overflow="hidden" wrapMode="none">
            {presentation().title}
          </text>
        </Match>
      </Switch>
    </box>
  )
}

function InlinePrompt(props: {
  agent: DispatchModel.AgentEntry
  directory: string
  width: number
  onClose: () => void
}) {
  const data = useData()
  const location = useLocation()
  const local = useLocal()
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  // Autocomplete, slash commands and the model catalog follow the location context, so point it at
  // the agent while the prompt is open, and match the agent's own agent and model so sending from
  // here never switches them.
  const previous = location.ref
  const session = data.session.get(props.agent.sessionID)
  location.set(session?.location ?? { directory: props.directory })
  if (session?.agent) local.agent.set(session.agent)
  if (session?.model) {
    local.model.set({ providerID: session.model.providerID, modelID: session.model.id })
    local.model.variant.set(session.model.variant)
  }
  onCleanup(() => location.set(previous))
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={dimensions().width}
      height={dimensions().height}
      zIndex={1500}
      justifyContent="center"
      alignItems="center"
    >
      <box width={props.width} flexDirection="column" gap={0}>
        <box flexDirection="row" paddingLeft={1}>
          <text fg={theme.text.muted}>
            Message <span style={{ fg: theme.text.base }}>{props.agent.name}</span>
          </text>
          <box flexGrow={1} />
          <text>
            <span style={{ fg: theme.text.base, attributes: TextAttributes.BOLD }}>esc</span>
            <span style={{ fg: theme.text.muted }}> dismiss</span>
          </text>
        </box>
        <Prompt sessionID={props.agent.sessionID} visible={true} onSubmit={() => queueMicrotask(props.onClose)} />
      </box>
    </box>
  )
}

function Footer(props: { context: Plugin.Context; github: boolean }) {
  const theme = useTheme()
  const palette = () => props.context.keymap.shortcuts("command.palette.show")[0]
  const hint = (key: string, label: string) => (
    <text>
      <span style={{ fg: theme.text.base, attributes: TextAttributes.BOLD }}>{key}</span>
      <span style={{ fg: theme.text.muted }}> {label}</span>
    </text>
  )
  return (
    <box paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={3} flexShrink={0} flexWrap="wrap">
        {hint("a", "new agent")}
        {hint("w", "new worktree")}
        {hint("d", "remove")}
        {hint("x", "delete worktree")}
        <Show when={props.github}>
          {hint("P", "create PR")}
          {hint("o", "copy url")}
          {hint("M", "merge")}
        </Show>
        {hint("r", "refresh PR statuses")}
        {hint("c", "copy path")}
      </box>
      <box flexDirection="row" gap={3} flexShrink={0} flexWrap="wrap">
        {hint("↑↓/j/k", "navigate")}
        {hint("1-0", "jump")}
        {hint("enter", "open")}
        {hint("i", "message")}
        {hint("y/n", "approve/deny")}
        {hint("D", "diff")}
        {hint("t", "terminal")}
        <Show when={palette()}>{(key) => hint(key(), "commands")}</Show>
      </box>
    </box>
  )
}
