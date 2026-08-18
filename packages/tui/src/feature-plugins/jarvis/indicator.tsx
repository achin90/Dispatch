import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Show } from "solid-js"
import type { VoiceState } from "./voice-state"

/**
 * Always-visible voice status, registered into the global `app_bottom` slot so
 * it shows on both the dashboard and inside a session.
 *
 * Ambient listening has no other affordance — without this, "voice mode is off"
 * and "voice mode is on but nothing was heard" look exactly the same.
 */
export function VoiceIndicator(props: { api: TuiPluginApi; voice: VoiceState }) {
  const theme = () => props.api.theme.current
  const label = () => {
    if (props.voice.status() === "thinking") return "thinking"
    if (props.voice.status() === "speaking") return "speaking"
    return "listening"
  }
  const color = () => {
    if (props.voice.status() === "thinking") return theme().warning
    if (props.voice.status() === "speaking") return theme().info
    return theme().success
  }

  return (
    <Show when={props.voice.mode() === "on"}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={color()}>●</text>
        <text fg={theme().textMuted}>{"jarvis " + label()}</text>
      </box>
    </Show>
  )
}
