import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { DialogFooter, DialogHeader, DialogLayout } from "../../ui/dialog"
import { errorMessage } from "../../util/error"
import { DispatchRpc } from "./rpc"

const BAR_WIDTH = 40

/** What each local-usage behavior means, and what to do about it. */
const BEHAVIORS: Record<string, { title: string; hint: string }> = {
  long_context: { title: "Start fresh when you switch tasks", hint: "open a new session" },
  cache_miss: { title: "Idle sessions re-read their context", hint: "finish tasks in one sitting" },
  subagent_heavy: { title: "Subagents add up", hint: "each one reads its own context" },
  high_parallel: { title: "Many sessions at once", hint: "parallel work uses limits faster" },
  cron: { title: "Stop sessions you no longer need", hint: "some ran for hours" },
}

/** The `/usage` popup: Claude plan limits and what used them, read through the Claude Agent SDK. */
export function DialogUsage() {
  const client = useClient()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const maxHeight = createMemo(() => Math.max(8, Math.floor(dimensions().height * 0.7)))
  const [range, setRange] = createSignal<"day" | "week">("day")
  const [usage, { refetch }] = createResource(() =>
    DispatchRpc.call(client.api, "usage.get", {}).catch((error: unknown) => ({
      error:
        error instanceof DispatchRpc.UnavailableError ? "This server cannot read Claude usage" : errorMessage(error),
    })),
  )
  const data = () => {
    const value = usage.latest
    return value && !("error" in value) ? value : undefined
  }
  const failure = () => {
    const value = usage.latest
    return value && "error" in value ? value.error : undefined
  }
  const toggle = () => void setRange((value) => (value === "day" ? "week" : "day"))
  let scroll: ScrollBoxRenderable | undefined

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "tab", title: "Switch 24h / 7d", group: "Dialog", run: toggle },
      { bind: "r", title: "Refresh usage", group: "Dialog", run: () => void refetch() },
    ],
  }))

  useKeyboard((event) => {
    if (!scroll) return
    if (event.name === "up" || event.name === "k") return scroll.scrollBy(-1)
    if (event.name === "down" || event.name === "j") return scroll.scrollBy(1)
    if (event.name === "pageup") return scroll.scrollBy(-maxHeight())
    if (event.name === "pagedown") return scroll.scrollBy(maxHeight())
  })

  const footer = () => ({
    secondary: [
      { title: range() === "day" ? "last 7d" : "last 24h", key: "tab", onTrigger: toggle },
      { title: "refresh", key: "r", onTrigger: () => void refetch() },
    ],
  })

  return (
    <DialogLayout
      header={
        <DialogHeader
          gap={2}
          titleView={
            <text attributes={TextAttributes.BOLD} fg={theme.text.base} flexShrink={0}>
              /usage
            </text>
          }
        >
          <text fg={theme.text.muted} wrapMode="none" flexGrow={1} truncate>
            {data()?.plan ? `${capitalize(data()?.plan ?? "")} plan` : ""}
          </text>
        </DialogHeader>
      }
      footer={{ actions: footer() }}
      legacyFooter={<DialogFooter actions={footer()} />}
    >
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        maxHeight={maxHeight()}
        contentOptions={{ minHeight: 0 }}
        scrollbarOptions={{ visible: false }}
      >
        <Switch>
          <Match when={usage.loading && !usage.latest}>
            <Spinner color={theme.text.muted}>Reading usage from Claude Code…</Spinner>
          </Match>
          <Match when={failure()}>{(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}</Match>
          <Match when={data()}>
            {(value) => (
              <box gap={1}>
                <Show
                  when={value().available}
                  fallback={
                    <text fg={theme.text.muted} wrapMode="word">
                      Plan limits only apply to a Claude subscription login, not an API key, Bedrock or Vertex.
                    </text>
                  }
                >
                  <For each={value().limits}>{(limit) => <Limit {...limit} />}</For>
                  <Show when={value().extra}>
                    {(extra) => (
                      <box>
                        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                          Extra usage
                        </text>
                        <text fg={theme.text.muted}>
                          {money(extra().used, extra().currency)} used
                          {extra().limit === null ? "" : ` of ${money(extra().limit, extra().currency)} this month`}
                        </text>
                      </box>
                    )}
                  </Show>
                </Show>
                <Show when={value().behaviors?.[range()]}>
                  {(window) => <Contributions window={window()} range={range()} />}
                </Show>
              </box>
            )}
          </Match>
        </Switch>
      </scrollbox>
    </DialogLayout>
  )
}

function Limit(props: { label: string; percent: number | null; resetsAt: string | null }) {
  const theme = useTheme().surface("dialog")
  const percent = () => Math.max(0, Math.min(100, props.percent ?? 0))
  const filled = () => Math.round((percent() / 100) * BAR_WIDTH)
  // Nearing or at the limit is status feedback.
  const color = () => {
    if (percent() >= 100) return theme.text.feedback.error.base
    if (percent() >= 80) return theme.text.feedback.warning.base
    return theme.text.base
  }
  return (
    <box>
      <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
        {props.label}
      </text>
      <box flexDirection="row" gap={1}>
        <text wrapMode="none" flexShrink={0}>
          <span style={{ fg: color() }}>{"█".repeat(filled())}</span>
          <span style={{ fg: theme.text.faint }}>{"█".repeat(BAR_WIDTH - filled())}</span>
        </text>
        <text fg={theme.text.base} wrapMode="none">
          {props.percent === null ? "unknown" : `${Math.round(props.percent)}% used`}
        </text>
      </box>
      <Show when={props.resetsAt}>
        {(resetsAt) => <text fg={theme.text.muted}>Resets {resetTime(resetsAt())}</text>}
      </Show>
    </box>
  )
}

function Contributions(props: { window: DispatchRpc.UsageWindow; range: "day" | "week" }) {
  const theme = useTheme().surface("dialog")
  const groups = () =>
    [
      { title: "Skills", items: props.window.skills },
      { title: "Agents", items: props.window.agents },
      { title: "Plugins", items: props.window.plugins },
      { title: "MCP servers", items: props.window.mcpServers },
    ].filter((group) => group.items.length > 0)
  return (
    <box gap={1}>
      <box>
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          What's contributing to your limits usage?
        </text>
        <text fg={theme.text.muted}>Approximate · sessions on this machine only</text>
      </box>
      <text fg={theme.text.muted}>
        {props.range === "day" ? "Last 24h" : "Last 7 days"} · {props.window.requests.toLocaleString()} requests in{" "}
        {props.window.sessions.toLocaleString()} sessions · shares overlap
      </text>
      <Show when={props.window.behaviors.length > 0}>
        <box>
          <For each={props.window.behaviors}>
            {(behavior) => (
              <text fg={theme.text.base} wrapMode="none" truncate>
                {`${behavior.percent}%`.padEnd(5)}
                {BEHAVIORS[behavior.key]?.title ?? behavior.key}
                <Show when={BEHAVIORS[behavior.key]}>
                  {(known) => <span style={{ fg: theme.text.muted }}> · {known().hint}</span>}
                </Show>
              </text>
            )}
          </For>
        </box>
      </Show>
      <For each={groups()}>
        {(group) => (
          <box>
            <box flexDirection="row" width={36} justifyContent="space-between">
              <text fg={theme.text.base}>{group.title}</text>
              <text fg={theme.text.muted}>% of usage</text>
            </box>
            <For each={group.items}>
              {(item) => (
                <box flexDirection="row" width={36} justifyContent="space-between">
                  <text fg={theme.text.muted} wrapMode="none" truncate flexShrink={1}>
                    {item.name}
                  </text>
                  <text fg={theme.text.muted} flexShrink={0}>
                    {item.percent}%
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

/** "2:19pm (America/Los_Angeles)" today, "Nov 5 at 5:59am (America/Los_Angeles)" otherwise, like the CLI. */
export function resetTime(iso: string, now = new Date()) {
  const date = new Date(iso)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase()
  if (date.toDateString() === now.toDateString()) return `${time} (${zone})`
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${day} at ${time} (${zone})`
}

function money(amount: number | null, currency: string | null) {
  if (amount === null) return "unknown"
  return amount.toLocaleString("en-US", { style: "currency", currency: currency ?? "USD" })
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
