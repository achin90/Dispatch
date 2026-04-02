import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import type { DiffStat, PermissionRequest } from "@opencode-ai/sdk/v2"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { useSync } from "../context/sync"
import { useDirectory } from "../context/directory"
import { useKV } from "../context/kv"
import { useRoute } from "@tui/context/route"
import { useSDK } from "../context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogDirectorySelect } from "@tui/component/dialog-directory-select"
import { DialogGitRepoSelect } from "@tui/component/dialog-git-repo-select"
import { Installation } from "@/installation"
import { Global } from "@/global"
import { Locale } from "@/util/locale"
import { Spinner } from "@tui/component/spinner"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "../context/exit"
import { useToast } from "@tui/ui/toast"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Clipboard } from "@tui/util/clipboard"
import { PtyAttach } from "../util/pty"

export interface AgentEntry {
  id: string
  name: string
  sessionID: string
  createdAt: number
  directory?: string
  worktree?: {
    branch: string
    directory: string
    sourceRepo: string
  }
  summary?: {
    text: string
    ai: boolean
  }
}

// Track which session the user last navigated into so we can restore cursor position
let lastEnteredSessionID: string | undefined

function filetype(filepath?: string) {
  if (!filepath) return "none"
  const ext = path.extname(filepath)
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(lang)) return "typescript"
  return lang ?? "none"
}

function PermissionDetail(props: { request: PermissionRequest; selected: boolean }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const fg = selectedForeground(theme)

  const input = createMemo(() => {
    const raw = props.request.metadata?.input
    if (raw && typeof raw === "object") return raw as Record<string, unknown>
    return {} as Record<string, unknown>
  })

  const diff = createMemo(() => {
    const raw = props.request.metadata?.diff
    return typeof raw === "string" ? raw : ""
  })

  const filepath = createMemo(() => {
    const raw = props.request.metadata?.filepath
    return typeof raw === "string" ? raw : ""
  })

  const color = () => (props.selected ? fg : theme.textMuted)

  return (
    <box paddingLeft={4} maxHeight={10}>
      <Switch>
        <Match when={props.request.permission === "bash"}>
          <text fg={theme.text} wrapMode="word" overflow="hidden">
            {"$ " + (typeof input().command === "string" ? input().command : (props.request.patterns[0] ?? ""))}
          </text>
        </Match>
        <Match when={(props.request.permission === "edit" || props.request.permission === "write") && diff()}>
          <scrollbox maxHeight={8} scrollbarOptions={{ visible: false }}>
            <diff
              diff={diff()}
              view="unified"
              filetype={filetype(filepath())}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode="word"
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </scrollbox>
        </Match>
        <Match when={props.request.permission === "edit" || props.request.permission === "write"}>
          <text fg={color()} overflow="hidden" wrapMode="none">
            {(props.request.permission === "edit" ? "Edit " : "Write ") +
              (filepath() || (props.request.patterns[0] ?? ""))}
          </text>
        </Match>
        <Match when={true}>
          <text fg={color()} overflow="hidden" wrapMode="none">
            {props.request.permission + " " + (props.request.patterns[0] ?? "")}
          </text>
        </Match>
      </Switch>
    </box>
  )
}

export function Home() {
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const route = useRoute()
  const sdk = useSDK()
  const directory = useDirectory()
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const exit = useExit()
  const renderer = useRenderer()
  const fg = selectedForeground(theme)

  const [attaching, setAttaching] = createSignal(false)

  const mcp = createMemo(() => Object.keys(sync.data.mcp).length > 0)
  const mcpError = createMemo(() => {
    return Object.values(sync.data.mcp).some((x) => x.status === "failed")
  })
  const connectedMcpCount = createMemo(() => {
    return Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  })

  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [dialogOpen, setDialogOpen] = createSignal(false)

  function resolveDir(agent: AgentEntry) {
    const dir = agent.worktree
      ? agent.worktree.directory
      : !agent.directory || agent.directory === "."
        ? sync.data.path.directory
        : sync.data.path.directory + "/" + agent.directory
    return dir.replace(/\/+$/, "")
  }

  function shortDir(dir: string) {
    return dir.replace(Global.Path.home, "~")
  }

  function hotkey(idx: number) {
    const n = idx + 1
    if (n <= 9) return String(n)
    if (n === 10) return "0"
    if (n <= 20) return "!@#$%^&*()"[n - 11]
    return String(n)
  }

  type EnrichedAgent = AgentEntry & {
    session: (typeof sync.data.session)[0] | undefined
    status: (typeof sync.data.session_status)[string] | undefined
  }

  const grouped = createMemo(() => {
    const entries: AgentEntry[] = kv.get("agents", [])
    const map = new Map<string, { dir: string; label: string; agents: EnrichedAgent[] }>()
    entries.forEach((entry) => {
      const dir = resolveDir(entry)
      if (!map.has(dir)) map.set(dir, { dir, label: shortDir(dir), agents: [] })
      map.get(dir)!.agents.push({
        ...entry,
        session: sync.data.session.find((s) => s.id === entry.sessionID),
        status: sync.data.session_status[entry.sessionID],
      })
    })
    return [...map.values()]
  })

  const flat = createMemo(() => grouped().flatMap((g) => g.agents))

  const children = createMemo(() => {
    const map = new Map<string, string[]>()
    sync.data.session.forEach((s) => {
      if (!s.parentID) return
      const list = map.get(s.parentID)
      if (list) list.push(s.id)
      else map.set(s.parentID, [s.id])
    })
    return map
  })

  function hasPending(sessionID: string): boolean {
    if ((sync.data.permission[sessionID]?.length ?? 0) > 0) return true
    if ((sync.data.question[sessionID]?.length ?? 0) > 0) return true
    return (
      children()
        .get(sessionID)
        ?.some((id) => hasPending(id)) ?? false
    )
  }

  function hasPermission(sessionID: string): boolean {
    if ((sync.data.permission[sessionID]?.length ?? 0) > 0) return true
    return (
      children()
        .get(sessionID)
        ?.some((id) => hasPermission(id)) ?? false
    )
  }

  function approval(sessionID: string): PermissionRequest | undefined {
    const perms = sync.data.permission[sessionID]
    if (perms && perms.length > 0) return perms[0]
    const kids = children().get(sessionID)
    if (!kids) return undefined
    for (const id of kids) {
      const p = approval(id)
      if (p) return p
    }
    return undefined
  }

  const [diffStats, setDiffStats] = createSignal<Record<string, DiffStat>>({})
  // Worktrees whose background checkout (--no-checkout + forked boot)
  // hasn't finished yet.  Keyed by branch so we can match the
  // server-emitted worktree.ready event (which only carries branch).
  const pending = new Map<string, string>() // branch → dir

  function fetchDiffStats() {
    const dirs = new Set(pending.values())
    for (const group of grouped()) {
      if (dirs.has(group.dir)) continue
      sdk.client.worktree.diffstat({ directory: group.dir }).then((res) => {
        if (!res.data) return
        setDiffStats((prev) => ({ ...prev, [group.dir]: res.data! }))
      })
    }
  }

  createEffect(on(grouped, () => fetchDiffStats()))

  sdk.event.on("worktree.ready", (evt) => {
    if (pending.delete(evt.properties.branch)) fetchDiffStats()
  })

  // Restore selection to the last-entered agent
  if (lastEnteredSessionID) {
    const idx = flat().findIndex((a) => a.sessionID === lastEnteredSessionID)
    if (idx >= 0) setSelectedIndex(idx)
  }

  function move(direction: number) {
    const len = flat().length
    if (len === 0) return
    setSelectedIndex((i) => {
      const next = i + direction
      if (next < 0) return len - 1
      if (next >= len) return 0
      return next
    })
  }

  function selected() {
    return flat()[selectedIndex()]
  }

  function insertAgent(entry: AgentEntry) {
    const current: AgentEntry[] = kv.get("agents", [])
    const dir = resolveDir(entry)
    // Insert after the last agent in the same directory group
    const last = current.reduce((acc, a, i) => (resolveDir(a) === dir ? i : acc), -1)
    const idx = last === -1 ? current.length : last + 1
    const next = [...current.slice(0, idx), entry, ...current.slice(idx)]
    kv.set("agents", next)
    setSelectedIndex(idx)
  }

  let scroll: ScrollBoxRenderable | undefined

  function scrollToSelected() {
    if (!scroll) return
    const children = scroll.getChildren()
    // Find the child with matching id since headers are interleaved
    const target = children.find((c) => c.id === String(selectedIndex()))
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1)
    }
    if (y < 0) {
      scroll.scrollBy(y)
    }
  }

  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) {
      exit()
      return
    }
    if (dialogOpen() || dialog.stack.length > 0) return
    if (keybind.leader) return
    if (flat().length === 0 && evt.name !== "a" && evt.name !== "w") return

    const sym = evt.name.length === 1 ? "!@#$%^&*()".indexOf(evt.name) : -1
    const num = sym !== -1 ? sym + 11 : parseInt(evt.name)
    if (sym !== -1 || !isNaN(num)) {
      const idx = sym !== -1 ? num : num === 0 ? 10 : num
      if (idx >= 1 && idx <= flat().length) {
        setSelectedIndex(idx - 1)
        scrollToSelected()
      }
    }

    if (evt.name === "j" || evt.name === "down") {
      move(1)
      scrollToSelected()
    }
    if (evt.name === "k" || evt.name === "up") {
      move(-1)
      scrollToSelected()
    }
    if (evt.name === "return") {
      const agent = selected()
      if (agent) {
        lastEnteredSessionID = agent.sessionID
        route.navigate({ type: "session", sessionID: agent.sessionID })
      }
    }
    if (evt.name === "c") {
      const agent = selected()
      if (!agent) return
      const dir = resolveDir(agent)
      Clipboard.copy(dir)
        .then(() => toast.show({ message: "Copied path to clipboard", variant: "info" }))
        .catch(() => toast.show({ message: "Failed to copy path", variant: "error" }))
    }
    if (evt.name === "a") {
      ;(async () => {
        setDialogOpen(true)
        const dir = await DialogDirectorySelect.show(dialog, "Select Directory")
        if (!dir) {
          dialog.clear()
          setDialogOpen(false)
          return
        }
        const name = await DialogPrompt.show(dialog, "New Agent", {
          placeholder: "Agent name",
        })
        dialog.clear()
        setDialogOpen(false)
        if (!name) return
        const absoluteDir = dir === "." ? sync.data.path.directory : sync.data.path.directory + "/" + dir
        const result = await sdk.client.session.create({
          directory: absoluteDir,
        })
        if (!result.data) return
        const wt = (await sdk.client.worktree.info({ directory: absoluteDir })).data
        insertAgent({
          id: crypto.randomUUID(),
          name,
          sessionID: result.data.id,
          createdAt: Date.now(),
          directory: dir,
          worktree: wt ? { branch: wt.branch, directory: wt.directory, sourceRepo: wt.sourceRepo } : undefined,
        })
      })()
    }
    if (evt.name === "w") {
      ;(async () => {
        setDialogOpen(true)
        const repoDir = await DialogGitRepoSelect.show(
          dialog,
          "Select Source Repository",
          sync.data.path.directory,
          "Choose the repository to create a new worktree from",
        )
        if (!repoDir) {
          dialog.clear()
          setDialogOpen(false)
          return
        }
        const name = await DialogPrompt.show(dialog, "New Worktree Agent", {
          placeholder: "Agent name (used as branch)",
        })
        dialog.clear()
        setDialogOpen(false)
        if (!name) return
        const worktree = (
          await sdk.client.worktree.create({
            directory: repoDir,
            worktreeCreateInput: { name },
          })
        ).data
        if (!worktree) return
        // Pre-seed zero diff stats so the effect doesn't race the
        // background worktree checkout (--no-checkout + forked boot).
        const dir = worktree.directory.replace(/\/+$/, "")
        pending.set(worktree.branch, dir)
        setDiffStats((prev) => ({
          ...prev,
          [dir]: { additions: 0, deletions: 0, files: 0 },
        }))
        const session = (
          await sdk.client.session.create({
            directory: worktree.directory,
          })
        ).data
        if (!session) return
        insertAgent({
          id: crypto.randomUUID(),
          name,
          sessionID: session.id,
          createdAt: Date.now(),
          directory: worktree.directory,
          worktree: {
            branch: worktree.branch,
            directory: worktree.directory,
            sourceRepo: repoDir,
          },
        })
      })()
    }
    if (evt.name === "d" && !evt.shift) {
      const agent = selected()
      if (!agent) return
      ;(async () => {
        setDialogOpen(true)
        const ok = await DialogConfirm.show(dialog, "Remove Agent", `Remove "${agent.name}" from the dashboard?`)
        dialog.clear()
        setDialogOpen(false)
        if (!ok) return
        const current: AgentEntry[] = kv.get("agents", [])
        kv.set(
          "agents",
          current.filter((a) => a.id !== agent.id),
        )
        setSelectedIndex((i) => Math.min(i, flat().length - 1))
      })()
    }
    if (evt.name === "x") {
      const agent = selected()
      if (!agent) return
      const dir = resolveDir(agent)
      ;(async () => {
        const wt = (await sdk.client.worktree.info({ directory: dir })).data
        if (!wt) return
        setDialogOpen(true)
        const ok = await DialogConfirm.show(
          dialog,
          "Delete Worktree",
          `Delete worktree and all agents in ${shortDir(dir)}?`,
        )
        if (!ok) {
          dialog.clear()
          setDialogOpen(false)
          return
        }
        dialog.replace(() => (
          <box paddingBottom={1} paddingLeft={4} paddingRight={4}>
            <Spinner>Deleting worktree…</Spinner>
          </box>
        ))
        try {
          await sdk.client.worktree.remove({
            directory: dir,
            worktreeRemoveInput: { directory: dir },
          })
          const current: AgentEntry[] = kv.get("agents", [])
          kv.set(
            "agents",
            current.filter((a) => resolveDir(a) !== dir),
          )
        } catch {
          toast.show({ message: "Failed to delete worktree", variant: "error" })
        } finally {
          dialog.clear()
          setDialogOpen(false)
        }
        setSelectedIndex((i) => Math.min(i, flat().length - 1))
      })()
    }
    if (evt.name === "d" && evt.shift) {
      const agent = selected()
      if (!agent) return
      const dir = resolveDir(agent)
      route.navigate({ type: "diffview", directory: dir })
    }
    if (evt.name === "y") {
      const agent = selected()
      if (!agent) return
      const perm = approval(agent.sessionID)
      if (!perm) return
      sdk.client.permission.reply({
        reply: "once",
        requestID: perm.id,
      })
    }
    if (evt.name === "n") {
      const agent = selected()
      if (!agent) return
      const perm = approval(agent.sessionID)
      if (!perm) return
      sdk.client.permission.reply({
        reply: "reject",
        requestID: perm.id,
      })
    }
    if (evt.name === "t") {
      if (attaching()) return
      const agent = selected()
      if (!agent) return
      const dir = resolveDir(agent)
      const leader = keybind.all.leader?.[0]
      const byte = leader?.ctrl && leader.name
        ? leader.name.toLowerCase().charCodeAt(0) - 96
        : 0x18
      setAttaching(true)
      const fgInts = fg.toInts()
      const bgInts = theme.primary.toInts()
      PtyAttach.open(agent.id, dir, renderer, {
        leader: byte,
        label: keybind.print("dashboard"),
        dir: shortDir(dir),
        fg: [fgInts[0], fgInts[1], fgInts[2]],
        bg: [bgInts[0], bgInts[1], bgInts[2]],
      }).catch(() => {}).finally(() => setAttaching(false))
    }
  })

  return (
    <>
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
        {/* Header */}
        <box flexDirection="row" flexShrink={0}>
          <box width={4} flexShrink={0}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              #
            </text>
          </box>
          <box width="30%" flexShrink={0}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Name
            </text>
          </box>
          <box width={18} flexShrink={0}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Status
            </text>
          </box>
          <box flexGrow={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Activity
            </text>
          </box>
        </box>

        {/* Agent rows */}
        <Show
          when={flat().length > 0}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={theme.textMuted}>No agents yet. Press 'a' to create or 'w' for worktree.</text>
            </box>
          }
        >
          <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }} ref={(r: ScrollBoxRenderable) => (scroll = r)}>
            <For each={grouped()}>
              {(group) => (
                <>
                  <box paddingTop={1} paddingBottom={0} flexDirection="row">
                    <text fg={theme.accent} attributes={TextAttributes.BOLD} overflow="hidden" wrapMode="none">
                      {group.label}
                    </text>
                    <Show when={diffStats()[group.dir]}>
                      {(stats) => (
                        <text>
                          {"  "}
                          <span style={{ fg: theme.success }}>+{stats().additions}</span>{" "}
                          <span style={{ fg: theme.error }}>-{stats().deletions}</span>{" "}
                          <span style={{ fg: theme.textMuted }}>
                            {stats().files} {Locale.pluralize(stats().files, "file", "files")}
                          </span>
                        </text>
                      )}
                    </Show>
                  </box>
                  <For each={group.agents}>
                    {(agent) => {
                      const idx = createMemo(() => flat().indexOf(agent))
                      const isSelected = createMemo(() => idx() === selectedIndex())
                      return (
                        <box id={String(idx())} flexDirection="column">
                          <box flexDirection="row" backgroundColor={isSelected() ? theme.primary : undefined}>
                            <box width={4} flexShrink={0}>
                              <text fg={isSelected() ? fg : theme.textMuted}>{hotkey(idx())}</text>
                            </box>
                            <box width="30%" flexShrink={0}>
                              <text
                                fg={isSelected() ? fg : theme.text}
                                attributes={isSelected() ? TextAttributes.BOLD : undefined}
                                overflow="hidden"
                                wrapMode="none"
                              >
                                {agent.name}
                              </text>
                            </box>
                            <box width={18} flexShrink={0}>
                              <Switch>
                                <Match when={hasPermission(agent.sessionID)}>
                                  <text fg={isSelected() ? fg : theme.warning}>Approve (y/n)</text>
                                </Match>
                                <Match when={hasPending(agent.sessionID)}>
                                  <text fg={isSelected() ? fg : theme.warning}>Waiting for user</text>
                                </Match>
                                <Match when={agent.status?.type === "busy"}>
                                  <Spinner color={isSelected() ? fg : theme.success}>Working</Spinner>
                                </Match>
                                <Match when={agent.status?.type === "retry"}>
                                  <text fg={isSelected() ? fg : theme.error}>Retrying</text>
                                </Match>
                                <Match when={true}>
                                  <text fg={isSelected() ? fg : theme.warning}>Waiting for user</text>
                                </Match>
                              </Switch>
                            </box>
                            <box flexGrow={1} flexShrink={1} minWidth={0}>
                              <Show
                                when={agent.status?.type === "busy" && agent.status.activity}
                                fallback={<text fg={isSelected() ? fg : theme.textMuted}>-</text>}
                              >
                                {(activity) => (
                                  <text fg={isSelected() ? fg : theme.textMuted} overflow="hidden" wrapMode="none">
                                    {activity()}
                                  </text>
                                )}
                              </Show>
                            </box>
                          </box>
                          <Show
                            when={approval(agent.sessionID)}
                            fallback={
                              <Show when={kv.get("agent_summaries_visible", true) && sync.data.agent_summary[agent.sessionID]}>
                                {(s) => (
                                  <box paddingLeft={4} maxHeight={4}>
                                    <text fg={theme.textMuted} wrapMode="word" overflow="hidden">
                                      {(s().ai ? "Summary: " : "") + s().text}
                                    </text>
                                  </box>
                                )}
                              </Show>
                            }
                          >
                            {(perm) => <PermissionDetail request={perm()} selected={isSelected()} />}
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
      <box paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="column" flexShrink={0} gap={0}>
        <box flexDirection="row" gap={3} flexShrink={0}>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>a</span>
            <span style={{ fg: theme.textMuted }}> new agent</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>w</span>
            <span style={{ fg: theme.textMuted }}> new worktree</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>d</span>
            <span style={{ fg: theme.textMuted }}> remove agent</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>x</span>
            <span style={{ fg: theme.textMuted }}> delete worktree</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>c</span>
            <span style={{ fg: theme.textMuted }}> copy path</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>D</span>
            <span style={{ fg: theme.textMuted }}> diff</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>enter</span>
            <span style={{ fg: theme.textMuted }}> open</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>t</span>
            <span style={{ fg: theme.textMuted }}> terminal</span>
          </text>
          <text>
            <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>{keybind.print("command_list")}</span>
            <span style={{ fg: theme.textMuted }}> commands</span>
          </text>
        </box>
        <box flexDirection="row" paddingTop={1} gap={2}>
          <text fg={theme.textMuted}>{directory()}</text>
          <box gap={1} flexDirection="row" flexShrink={0}>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: connectedMcpCount() > 0 ? theme.success : theme.textMuted }}>⊙ </span>
                  </Match>
                </Switch>
                {connectedMcpCount()} MCP
              </text>
              <text fg={theme.textMuted}>/status</text>
            </Show>
          </box>
          <box flexGrow={1} />
          <box flexShrink={0}>
            <text fg={theme.textMuted}>{Installation.VERSION}</text>
          </box>
        </box>
      </box>
    </>
  )
}
