import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { VoiceState } from "./voice-state"

/**
 * Always-visible voice status, rendered in the global `app` slot so it shows
 * on the dashboard and inside a session.
 *
 * Ambient listening has no other affordance — without this, "voice mode is off"
 * and "voice mode is on but nothing was heard" look exactly the same.
 */
export function VoiceIndicator(props: { context: Plugin.Context; voice: VoiceState }) {
  const theme = () => props.context.theme
  const color = () => {
    if (props.voice.status() === "thinking") return theme().text.feedback.warning.base
    if (props.voice.status() === "speaking") return theme().text.feedback.info.base
    return theme().text.feedback.success.base
  }

  return (
    <Show when={props.voice.mode() === "on"}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={2}>
        <text fg={color()}>●</text>
        <text fg={theme().text.muted} wrapMode="none">
          {"jarvis " + props.voice.status()}
        </text>
      </box>
    </Show>
  )
}
