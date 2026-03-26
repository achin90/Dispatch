import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { useSync } from "../context/sync"
import { useDirectory } from "../context/directory"
import { useKV } from "../context/kv"
import { useRoute } from "@tui/context/route"
import { useSDK } from "../context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogDirectorySelect } from "@tui/component/dialog-directory-select"
import { DialogGitRepoSelect } from "@tui/component/dialog-git-repo-select"
import { Installation } from "@/installation"
import { Locale } from "@/util/locale"
import { Spinner } from "@tui/component/spinner"
import { useKeyboard } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeybind } from "@tui/context/keybind"
import { useExit } from "../context/exit"

interface AgentEntry {
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
}

export function Home() {
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const route = useRoute()
  const sdk = useSDK()
  const directory = useDirectory()
  const dialog = useDialog()
  const keybind = useKeybind()
  const exit = useExit()
  const fg = selectedForeground(theme)

  const mcp = createMemo(() => Object.keys(sync.data.mcp).length > 0)
  const mcpError = createMemo(() => {
    return Object.values(sync.data.mcp).some((x) => x.status === "failed")
  })
  const connectedMcpCount = createMemo(() => {
    return Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  })

  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [toDelete, setToDelete] = createSignal<{ id: string; mode: "d" | "x" }>()
  const [dialogOpen, setDialogOpen] = createSignal(false)

  const agents = createMemo(() => {
    const entries: AgentEntry[] = kv.get("agents", [])
    return entries.map((entry) => {
      const session = sync.data.session.find((s) => s.id === entry.sessionID)
      const status = sync.data.session_status[entry.sessionID]
      return {
        ...entry,
        session,
        status,
      }
    })
  })

  function clampIndex(index: number) {
    const len = agents().length
    if (len === 0) return 0
    if (index < 0) return len - 1
    if (index >= len) return 0
    return index
  }

  let scroll: ScrollBoxRenderable | undefined

  function scrollToSelected() {
    if (!scroll) return
    const children = scroll.getChildren()
    const target = children[selectedIndex()]
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
    if (dialogOpen()) return
    if (agents().length === 0 && evt.name !== "a" && evt.name !== "w") return

    if (evt.name === "j" || evt.name === "down") {
      setSelectedIndex((i) => clampIndex(i + 1))
      setToDelete()
      scrollToSelected()
    }
    if (evt.name === "k" || evt.name === "up") {
      setSelectedIndex((i) => clampIndex(i - 1))
      setToDelete()
      scrollToSelected()
    }
    if (evt.name === "return") {
      const agent = agents()[selectedIndex()]
      if (agent) {
        route.navigate({ type: "session", sessionID: agent.sessionID })
      }
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
        const absoluteDir =
          dir === "." ? sync.data.path.directory : sync.data.path.directory + "/" + dir
        const result = await sdk.client.session.create({
          directory: absoluteDir,
        })
        if (!result.data) return
        const current: AgentEntry[] = kv.get("agents", [])
        const entry: AgentEntry = {
          id: crypto.randomUUID(),
          name,
          sessionID: result.data.id,
          createdAt: Date.now(),
          directory: dir,
        }
        kv.set("agents", [...current, entry])
        setSelectedIndex(current.length)
      })()
    }
    if (evt.name === "w") {
      ;(async () => {
        setDialogOpen(true)
        const repoDir = await DialogGitRepoSelect.show(dialog, "Select Git Repository", sync.data.path.directory)
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
        const worktree = (await sdk.client.worktree.create({
          directory: repoDir,
          worktreeCreateInput: { name },
        })).data
        if (!worktree) return
        const session = (await sdk.client.session.create({
          directory: worktree.directory,
        })).data
        if (!session) return
        const current: AgentEntry[] = kv.get("agents", [])
        const entry: AgentEntry = {
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
        }
        kv.set("agents", [...current, entry])
        setSelectedIndex(current.length)
      })()
    }
    if (evt.name === "d") {
      const agent = agents()[selectedIndex()]
      if (!agent) return
      if (toDelete()?.id === agent.id && toDelete()?.mode === "d") {
        const current: AgentEntry[] = kv.get("agents", [])
        kv.set(
          "agents",
          current.filter((a) => a.id !== agent.id),
        )
        setToDelete()
        setSelectedIndex((i) => Math.min(i, agents().length - 1))
      } else {
        setToDelete({ id: agent.id, mode: "d" })
      }
    }
    if (evt.name === "x") {
      const agent = agents()[selectedIndex()]
      if (!agent?.worktree) return
      if (toDelete()?.id === agent.id && toDelete()?.mode === "x") {
        const dir = agent.worktree.directory
        const current: AgentEntry[] = kv.get("agents", [])
        kv.set(
          "agents",
          current.filter((a) => a.worktree?.directory !== dir),
        )
        sdk.client.worktree.remove({
          directory: agent.worktree.sourceRepo,
          worktreeRemoveInput: { directory: dir },
        })
        setToDelete()
        setSelectedIndex((i) => Math.min(i, agents().length - 1))
      } else {
        setToDelete({ id: agent.id, mode: "x" })
      }
    }
  })

  return (
    <>
      <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
        {/* Header */}
        <box flexDirection="row" flexShrink={0}>
          <box width={4}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              #
            </text>
          </box>
          <box flexGrow={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Name
            </text>
          </box>
          <box width={20}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Status
            </text>
          </box>
          <box width={25}>
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              Activity
            </text>
          </box>
        </box>

        {/* Agent rows */}
        <Show
          when={agents().length > 0}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={theme.textMuted}>No agents yet. Press 'a' to create or 'w' for worktree.</text>
            </box>
          }
        >
          <scrollbox
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
            ref={(r: ScrollBoxRenderable) => (scroll = r)}
          >
            <For each={agents()}>
              {(agent, index) => {
                const isSelected = createMemo(() => index() === selectedIndex())
                const isDeleting = createMemo(() => toDelete()?.id === agent.id)
                return (
                  <box
                    flexDirection="row"
                    backgroundColor={isDeleting() ? theme.error : isSelected() ? theme.primary : undefined}
                  >
                    <box width={4}>
                      <text fg={isSelected() || isDeleting() ? fg : theme.textMuted}>{index() + 1}</text>
                    </box>
                    <box flexGrow={1}>
                      <text
                        fg={isSelected() || isDeleting() ? fg : theme.text}
                        attributes={isSelected() ? TextAttributes.BOLD : undefined}
                        overflow="hidden"
                        wrapMode="none"
                      >
                        {isDeleting()
                          ? toDelete()?.mode === "x"
                            ? "Press 'x' again to delete worktree + all agents"
                            : "Press 'd' again to remove agent"
                          : agent.name}
                      </text>
                    </box>
                    <box width={20}>
                      <Switch>
                        <Match when={agent.status?.type === "busy"}>
                          <Spinner color={isSelected() ? fg : undefined}>Working</Spinner>
                        </Match>
                        <Match when={agent.status?.type === "retry"}>
                          <text fg={isSelected() ? fg : theme.warning}>Retrying</text>
                        </Match>
                        <Match when={true}>
                          <text fg={isSelected() ? fg : theme.textMuted}>Waiting for user</text>
                        </Match>
                      </Switch>
                    </box>
                    <box width={25}>
                      <Show
                        when={agent.session?.summary}
                        fallback={<text fg={isSelected() ? fg : theme.textMuted}>-</text>}
                      >
                        {(summary) => (
                          <text fg={isSelected() ? fg : theme.textMuted}>
                            +{summary().additions} -{summary().deletions} {summary().files}{" "}
                            {Locale.pluralize(summary().files, "file", "files")}
                          </text>
                        )}
                      </Show>
                    </box>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </box>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0} gap={2}>
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
    </>
  )
}
