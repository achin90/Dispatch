import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

export type VoiceMode = "off" | "on"

/**
 * What Jarvis is doing right now, surfaced by the status indicator. Decoding a
 * 0.6B model takes long enough that without this the UI looks identical to
 * "not listening".
 */
export type VoiceStatus = "listening" | "thinking" | "speaking"

export type PendingResponse = {
  type: "agent-name" | "deny-reason"
  resolve: (value: string) => void
  timeout: ReturnType<typeof setTimeout>
}

export type VoiceState = ReturnType<typeof createVoiceState>

export function createVoiceState(context: Plugin.Context) {
  // Signals, not plain variables: the status indicator renders from these, and
  // a plain variable would never trigger a re-render.
  const [mode, setModeSignal] = createSignal<VoiceMode>("off")
  const [status, setStatus] = createSignal<VoiceStatus>("listening")
  let currentPending: PendingResponse | undefined
  const changeHandlers = new Set<(mode: VoiceMode) => void>()

  /** Runs when the mode actually changes, so the mic follows the flag. */
  function onChange(handler: (mode: VoiceMode) => void) {
    changeHandlers.add(handler)
    return () => changeHandlers.delete(handler)
  }

  function setMode(next: VoiceMode, options?: { quiet?: boolean }) {
    if (mode() === next) return
    setModeSignal(next)
    setStatus("listening")
    for (const handler of changeHandlers) handler(next)
    // "On" is confirmed by the caller once the microphone has actually opened.
    if (next === "off" && !options?.quiet)
      context.ui.toast.show({ variant: "info", message: "Voice mode off", duration: 2000 })
  }

  function waitForResponse(type: PendingResponse["type"], timeoutMs = 15000) {
    if (currentPending) {
      clearTimeout(currentPending.timeout)
      currentPending.resolve("")
    }
    return new Promise<string | undefined>((resolve) => {
      const entry: PendingResponse = {
        type,
        resolve: (value) => {
          // Clear our own timer, and only clear the slot if it still holds
          // *this* entry. Without both, a stale timer from an answered
          // question fires later and wipes out the next one, so the following
          // answer resolves nothing and the question repeats forever.
          clearTimeout(entry.timeout)
          if (currentPending === entry) currentPending = undefined
          resolve(value)
        },
        timeout: setTimeout(() => {
          if (currentPending === entry) currentPending = undefined
          resolve(undefined)
        }, timeoutMs),
      }
      currentPending = entry
    })
  }

  return {
    mode,
    setMode,
    toggle: () => setMode(mode() === "on" ? "off" : "on"),
    status,
    setStatus,
    onChange,
    pending: () => currentPending,
    waitForResponse,
  }
}
