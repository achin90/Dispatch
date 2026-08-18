import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createVoiceState } from "./voice-state"
import { createTTS } from "./tts"
import { createSTT } from "./stt"
import { createCommandDispatcher } from "./commands"
import { showVoiceHelp } from "./help"
import { VoiceIndicator } from "./indicator"
import { loadSoundFile, play } from "../../audio"
// Chosen by measured length, since each one's duration sets how long the mic
// stays shut. staplebops-05 (287ms) is the shortest sound available and goes
// on "ready", which is charged directly against your next sentence;
// bip-bop-03 (444ms) goes on "heard", where the hold overlaps decoding.
import heardPath from "@opencode-ai/ui/audio/bip-bop-03.mp3" with { type: "file" }
import readyPath from "@opencode-ai/ui/audio/staplebops-05.mp3" with { type: "file" }

const id = "internal:jarvis"

/**
 * How long each chime is held over the mic so it isn't transcribed as speech.
 * Both must exceed their sound's duration — a hold that ends early leaves the
 * tail of the chime playing into a live mic — but only barely, since this is
 * dead air where you can't be heard.
 */
const HEARD_MUTE_MS = 550
const READY_MUTE_MS = 350

const tui: TuiPlugin = async (api) => {
  const voiceState = createVoiceState(api)
  // Declared before the TTS so the speaking gate can reference it — the mic is
  // always open, so without this Jarvis transcribes its own output.
  const stt = createSTT({
    onError: (message) => api.ui.toast({ variant: "error", title: "Jarvis", message }),
    onSpeechEnd: () => {
      if (voiceState.mode() !== "on") return
      voiceState.setStatus("thinking")
      // No chime here — we don't know yet whether the utterance is actionable.
      // The chime plays after transcription, only if it matched a command.
    },
    onIdle: () => {
      // Only clear "thinking" — a reply may already have moved us to "speaking".
      if (voiceState.status() === "thinking") voiceState.setStatus("listening")
    },
  })
  const tts = createTTS((speaking) => {
    stt.setMuted(speaking)
    voiceState.setStatus(speaking ? "speaking" : "listening")
    // Speaking straight after a reply otherwise lands in the gate's release
    // window and is discarded. This marks the boundary out loud, and holds the
    // mic until it has finished so the chime itself can't be transcribed.
    if (!speaking) chime(readyPath, READY_MUTE_MS)
  })
  const commands = createCommandDispatcher(api, voiceState, tts)

  // Acknowledges a boundary out loud: one chime when a phrase is captured and
  // decoding starts, another when Jarvis is done talking and listening again.
  function chime(path: string, holdMs: number) {
    // Take the hold synchronously. Loading the sound is async, so acquiring it
    // afterwards would leave the mic live over exactly the moment it plays.
    stt.setMuted(true)
    const release = setTimeout(() => stt.setMuted(false), holdMs)
    void loadSoundFile(path)
      .then((sound) => {
        if (sound) play(sound, { volume: 0.4 })
      })
      .catch(() => {
        clearTimeout(release)
        stt.setMuted(false)
      })
  }

  // Track which agents were previously idle to detect transitions
  const wasIdle = new Set<string>()

  // Dashboard TTS: speak agent summaries when they transition to idle ("waiting for user")
  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (voiceState.mode() !== "on") return

    if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
      wasIdle.delete(sessionID)
      return
    }

    if (event.properties.status.type !== "idle") return
    if (wasIdle.has(sessionID)) return
    wasIdle.add(sessionID)

    // Skip if we're currently inside this session (auto-TTS handles that)
    const route = api.route.current
    if (route.name === "session" && route.params?.sessionID === sessionID) return

    // Wait briefly for AgentSummaries to fetch the summary, then speak it
    setTimeout(() => {
      if (voiceState.mode() !== "on") return
      const agents: Array<{ sessionID: string; name: string; summary?: { text: string; ai: boolean } }> =
        api.kv.get("agents", []) ?? []
      const agent = agents.find((a) => a.sessionID === sessionID)
      if (!agent) return

      const summaryText = agent.summary?.text
      if (summaryText) {
        void tts.speak(`${agent.name}: ${summaryText}`)
      } else {
        void tts.speak(`${agent.name} is waiting for you.`)
      }
    }, 2000)
  })

  // In-session auto-TTS: speak new assistant messages when in a session with voice mode on
  api.event.on("session.status", (event) => {
    if (voiceState.mode() !== "on") return
    if (event.properties.status.type !== "idle") return

    const route = api.route.current
    if (route.name !== "session" || !route.params) return
    if (route.params.sessionID !== event.properties.sessionID) return

    // We're in the session that just went idle — speak the last assistant message
    const messages = api.state.session.messages(event.properties.sessionID)
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return

    const parts = api.state.part(lastAssistant.id)
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join(" ")
      .trim()

    if (text) {
      void tts.speak(text.substring(0, 2000))
    }
  })

  // Permission prompt TTS: read out what permissions are being requested
  api.event.on("permission.asked", (event) => {
    if (voiceState.mode() !== "on") return

    const props = event.properties
    const patternsDesc = props.patterns.length ? props.patterns.join(", ") : ""
    const desc = patternsDesc
      ? `${props.permission} wants to run: ${patternsDesc}`
      : `${props.permission} is requesting permission.`
    void tts.speak(desc)
  })

  // Interrupt handler: fires even while the main STT is muted (during TTS).
  // Only the wake word "jarvis" is used — common words like "stop" would
  // trigger on Jarvis's own voice since there's no echo cancellation.
  // Saying "Jarvis" kills playback; once TTS stops the mute gate lifts and
  // the next spoken phrase flows through onUtterance normally.
  stt.onInterrupt(() => {
    if (voiceState.mode() !== "on") return
    tts.stop()
    voiceState.setStatus("listening")
  })

  // STT → command dispatcher wiring
  stt.onUtterance(async (text) => {
    if (voiceState.mode() !== "on") return

    // First try bare utterance handling (permissions, pending responses — no wake word)
    const handled = await commands.handleBareUtterance(text)
    if (handled) {
      chime(heardPath, HEARD_MUTE_MS)
      return
    }

    // Then try wake-word-prefixed commands — only chime if it starts with the
    // wake word, so background noise and non-commands stay silent.
    const isJarvis = /^jarvis\b/i.test(text.trim())
    if (isJarvis) chime(heardPath, HEARD_MUTE_MS)
    await commands.handleUtterance(text)
  })

  // The one place the microphone follows the mode. Both the palette command and
  // the spoken "Jarvis, off" just set the flag; previously only the palette
  // command stopped the mic, so saying "off" left it running and still chiming.
  voiceState.onChange(async (mode) => {
    if (mode === "off") {
      tts.stop()
      void stt.stop()
      return
    }
    await tts.init()
    const failure = await stt.start()
    if (failure) {
      // Announcing "online" when the mic never opened is worse than silence —
      // it reports a working state that doesn't exist.
      voiceState.setMode("off")
      api.ui.toast({ variant: "error", title: "Jarvis", message: `Microphone failed: ${failure}` })
      await tts.speak("I couldn't open the microphone.")
      return
    }
    await tts.speak("Jarvis online.")
  })

  // Global slot, so the status shows on the dashboard and inside a session.
  api.slots.register({
    order: 100,
    slots: {
      app_bottom() {
        return <VoiceIndicator api={api} voice={voiceState} />
      },
    },
  })

  // Command palette entry to toggle voice mode
  api.keymap.registerLayer({
    commands: [
      {
        name: "jarvis.toggle",
        title: "Toggle Jarvis voice mode",
        category: "Jarvis",
        namespace: "palette",
        run: () => voiceState.toggle(),
      },
      {
        name: "jarvis.help",
        title: "Show Jarvis voice commands",
        category: "Jarvis",
        namespace: "palette",
        run: () => {
          showVoiceHelp(api)
        },
      },
    ],
  })

  // Clean up on unmount
  api.lifecycle.onDispose(() => {
    stt.dispose()
    tts.dispose()
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
