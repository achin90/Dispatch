import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
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

export type VoiceState = {
  mode: () => VoiceMode
  setMode: (mode: VoiceMode) => void
  toggle: () => void
  status: () => VoiceStatus
  setStatus: (status: VoiceStatus) => void
  /** Runs when the mode actually changes, so the mic follows the flag. */
  onChange: (handler: (mode: VoiceMode) => void) => () => void
  pending: () => PendingResponse | undefined
  setPending: (pending: PendingResponse | undefined) => void
  waitForResponse: (type: PendingResponse["type"], timeoutMs?: number) => Promise<string | undefined>
}

export function createVoiceState(api: TuiPluginApi): VoiceState {
  // Signals, not plain variables: the status indicator renders from these, and
  // a plain variable would never trigger a re-render.
  const [mode, setModeSignal] = createSignal<VoiceMode>("off")
  const [status, setStatus] = createSignal<VoiceStatus>("listening")
  let currentPending: PendingResponse | undefined
  const changeHandlers = new Set<(mode: VoiceMode) => void>()

  const pending = () => currentPending

  function onChange(handler: (mode: VoiceMode) => void) {
    changeHandlers.add(handler)
    return () => changeHandlers.delete(handler)
  }

  function setMode(m: VoiceMode) {
    if (mode() === m) return
    setModeSignal(m)
    setStatus("listening")
    for (const handler of changeHandlers) handler(m)
    api.ui.toast({
      variant: m === "on" ? "success" : "info",
      message: m === "on" ? "Voice mode on" : "Voice mode off",
      duration: 2000,
    })
  }

  function toggle() {
    setMode(mode() === "on" ? "off" : "on")
  }

  function setPending(p: PendingResponse | undefined) {
    if (currentPending && !p) clearTimeout(currentPending.timeout)
    currentPending = p
  }

  function waitForResponse(type: PendingResponse["type"], timeoutMs = 15000): Promise<string | undefined> {
    if (currentPending) {
      clearTimeout(currentPending.timeout)
      currentPending.resolve("")
    }
    return new Promise<string | undefined>((resolve) => {
      const entry: PendingResponse = {
        type,
        resolve: (v) => {
          // Clear our own timer, and only clear the slot if it still holds
          // *this* entry. Without both, a stale timer from an answered
          // question fires later and wipes out the next one, so the following
          // answer resolves nothing and the question repeats forever.
          clearTimeout(entry.timeout)
          if (currentPending === entry) currentPending = undefined
          resolve(v)
        },
        timeout: setTimeout(() => {
          if (currentPending === entry) currentPending = undefined
          resolve(undefined)
        }, timeoutMs),
      }
      currentPending = entry
    })
  }

  return { mode, setMode, toggle, status, setStatus, onChange, pending, setPending, waitForResponse }
}
