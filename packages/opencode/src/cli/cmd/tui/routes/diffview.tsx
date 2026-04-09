import { createSignal, createMemo, onMount, Show, For } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "../context/sdk"
import { useKeybind } from "@tui/context/keybind"
import { Spinner } from "@tui/component/spinner"
import { useTuiConfig } from "../context/tui-config"
import { Global } from "@/global"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import path from "path"

interface FileDiff {
  file: string
  patch: string
}

function split(raw: string): FileDiff[] {
  return raw
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((part) => {
      const line = part.slice(0, part.indexOf("\n"))
      const file = line.match(/b\/(.+)$/)?.[1] ?? line
      return { file, patch: "diff --git " + part }
    })
}

function filetype(filepath: string) {
  const ext = path.extname(filepath)
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(lang)) return "typescript"
  return lang ?? "none"
}

export function Diffview() {
  const { theme, syntax } = useTheme()
  const route = useRoute()
  const data = useRouteData("diffview")
  const sdk = useSDK()
  const keybind = useKeybind()
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  let scroll: ScrollBoxRenderable | undefined

  const [raw, setRaw] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const label = createMemo(() => data.directory.replace(Global.Path.home, "~"))

  const files = createMemo(() => split(raw()))

  const view = createMemo(() => {
    if (config.diff_style === "stacked") return "unified" as const
    return dimensions().width > 120 ? ("split" as const) : ("unified" as const)
  })

  onMount(async () => {
    if (typeof (sdk.client.worktree as any)?.diff !== "function") {
      setLoading(false)
      setError("Diff view not available")
      return
    }
    const res = await (sdk.client.worktree as any).diff({ directory: data.directory })
    setLoading(false)
    if (!res.data) {
      setError("Not a git repository or no changes")
      return
    }
    setRaw((res.data as { diff: string }).diff)
  })

  useKeyboard((evt) => {
    if (keybind.match("app_exit", evt)) return
    if (evt.name === "escape" || evt.name === "q") {
      route.navigate({ type: "home" })
      return
    }
    if (!scroll) return
    if (keybind.match("messages_page_up", evt)) {
      scroll.scrollBy(-scroll.height / 2)
      return
    }
    if (keybind.match("messages_page_down", evt)) {
      scroll.scrollBy(scroll.height / 2)
      return
    }
    if (evt.name === "j" || evt.name === "down") {
      scroll.scrollBy(1)
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      scroll.scrollBy(-1)
      return
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexShrink={0} flexDirection="row" gap={2} paddingBottom={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          {label()}
        </text>
        <text fg={theme.textMuted}>diff</text>
      </box>
      <Show when={loading()}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <Spinner>Loading diff…</Spinner>
        </box>
      </Show>
      <Show when={!loading() && error()}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.error}>{error()}</text>
        </box>
      </Show>
      <Show when={!loading() && !error() && files().length === 0}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>No changes</text>
        </box>
      </Show>
      <Show when={!loading() && files().length > 0}>
        <scrollbox
          flexGrow={1}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <For each={files()}>
            {(entry) => (
              <box flexDirection="column" paddingBottom={1}>
                <box paddingBottom={0}>
                  <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                    {entry.file}
                  </text>
                </box>
                <diff
                  diff={entry.patch}
                  view={view()}
                  filetype={filetype(entry.file)}
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
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingTop={1} paddingBottom={1} flexDirection="row" gap={3}>
        <text>
          <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>esc</span>
          <span style={{ fg: theme.textMuted }}> back</span>
        </text>
        <text>
          <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>j/k</span>
          <span style={{ fg: theme.textMuted }}> scroll</span>
        </text>
        <text>
          <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>{keybind.print("messages_page_up")}</span>
          <span style={{ fg: theme.textMuted }}>{"/"}</span>
          <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>{keybind.print("messages_page_down")}</span>
          <span style={{ fg: theme.textMuted }}> page</span>
        </text>
      </box>
    </box>
  )
}
