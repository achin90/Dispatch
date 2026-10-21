import { Plugin } from "@opencode/plugin/tui"
import { questionSoundPath, voiceReadySoundPath } from "#attention-sounds"
import { onCleanup } from "solid-js"
import { loadSoundFile, play } from "../../audio"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"
import { usePathFormatter } from "../../context/path-format"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { permissionPresentation } from "../../util/permission"
import { createDirectoryAgent, createWorktreeAgent } from "../dispatch/create"
import { ROUTE } from "../dispatch/dashboard"
import { DispatchModel } from "../dispatch/model"
import { DispatchRpc } from "../dispatch/rpc"
import { dispatchState } from "../dispatch/state"
import { createCommandDispatcher, type CommandHost, type Focus } from "./commands"
import { showVoiceHelp } from "./help"
import { VoiceIndicator } from "./indicator"
import { createSTT, downloadModels, missingModels, MODELS_DIR } from "./stt"
import { createTTS } from "./tts"
import { VOICE_MODE_ENDED_PROMPT, VOICE_MODE_SYSTEM_PROMPT } from "./voice-prompt"
import { createVoiceState, type VoiceState } from "./voice-state"

/**
 * How long each chime is held over the mic so it isn't transcribed as speech.
 * Both must exceed their sound's duration — a hold that ends early leaves the
 * tail of the chime playing into a live mic — but only barely, since this is
 * dead air where you can't be heard. bip-bop-03 (444ms) plays when a phrase is
 * heard, where the hold overlaps decoding; staplebops-05 (287ms), the shortest
 * sound available, plays on "ready", which is charged against your next sentence.
 */
const HEARD_MUTE_MS = 550
const READY_MUTE_MS = 350

export default Plugin.define({
  id: "jarvis",
  setup(context) {
    const voice = createVoiceState(context)
    context.ui.slot({ append: "app", render: () => <Jarvis context={context} voice={voice} /> })
    return () => voice.setMode("off", { quiet: true })
  },
})

/** Owns the microphone, speech output and voice commands. Mounted once in the app slot. */
function Jarvis(props: { context: Plugin.Context; voice: VoiceState }) {
  const context = props.context
  const voice = props.voice
  const client = useClient()
  const data = useData()
  const local = useLocal()
  const paths = usePathFormatter()
  const toast = useToast()
  const store = dispatchState(context)
  const root = () => data.location.default().directory

  // Declared before the TTS so the speaking gate can reference it — the mic is
  // always open, so without this Jarvis transcribes its own output.
  const stt = createSTT({
    onError: (message) => toast.show({ variant: "error", title: "Jarvis", message }),
    onSpeechEnd: () => {
      // No chime here — we don't know yet whether the utterance is actionable.
      // The chime plays after transcription, only if it matched a command.
      if (voice.mode() === "on") voice.setStatus("thinking")
    },
    onIdle: () => {
      // Only clear "thinking" — a reply may already have moved us to "speaking".
      if (voice.status() === "thinking") voice.setStatus("listening")
    },
  })
  const tts = createTTS((speaking) => {
    stt.setMuted(speaking)
    voice.setStatus(speaking ? "speaking" : "listening")
    // Speaking straight after a reply otherwise lands in the gate's release
    // window and is discarded. This marks the boundary out loud, and holds the
    // mic until it has finished so the chime itself can't be transcribed.
    if (!speaking) chime(voiceReadySoundPath, READY_MUTE_MS)
  })

  // Acknowledges a boundary out loud: one chime when a phrase is captured and
  // decoding starts, another when Jarvis is done talking and listening again.
  function chime(file: string, holdMs: number) {
    // Take the hold synchronously. Loading the sound is async, so acquiring it
    // afterwards would leave the mic live over exactly the moment it plays.
    stt.setMuted(true)
    const release = setTimeout(() => stt.setMuted(false), holdMs)
    void loadSoundFile(file)
      .then((sound) => {
        if (sound) play(sound, { volume: 0.4 })
      })
      .catch(() => {
        clearTimeout(release)
        stt.setMuted(false)
      })
  }

  const focus = (): Focus => {
    const route = context.ui.router.current()
    if (route.type === "session")
      return { type: "session", sessionID: route.sessionID, root: data.session.root(route.sessionID) }
    if (route.type === "plugin" && route.id === DispatchModel.PLUGIN_ID && route.name === ROUTE)
      return { type: "dashboard", selected: context.state.home.selectedSessionID() }
    return { type: "other" }
  }
  const agentFor = (sessionID: string) =>
    context.state.dashboard.agents().find((agent) => agent.sessionID === sessionID)
  const createHost = () => ({ client, data, local, store, root: root() })

  // Sessions told about voice mode since it was turned on. v2 prompts carry no system field, so the
  // instruction is a hidden synthetic message admitted ahead of the first voice prompt.
  const voiced = new Set<string>()

  async function summary(sessionID: string) {
    const stored = store.summaries.bySession[sessionID]?.text
    if (stored) return stored
    return (await DispatchRpc.optional(context.client, "session.lastResponse", { sessionID }))?.text
  }

  async function lastResponse(sessionID: string) {
    const text = data.session.message
      .list(sessionID)
      .findLast((message) => message.type === "assistant")
      ?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .trim()
    if (text) return text
    return (await DispatchRpc.optional(context.client, "session.lastResponse", { sessionID }))?.text
  }

  const host: CommandHost = {
    voice,
    speak: (text) => tts.speak(text),
    focus,
    agents: () => context.state.dashboard.agents(),
    open(sessionID) {
      if (agentFor(sessionID))
        store.setState((draft) => {
          draft.lastEntered = sessionID
        })
      context.ui.router.navigate({ type: "session", sessionID })
    },
    home() {
      // The dashboard command already knows whether the dashboard is enabled.
      if (context.keymap.commands().some((command) => command.id === "session.dashboard"))
        return context.keymap.dispatch("session.dashboard")
      context.ui.router.navigate({ type: "home" })
    },
    agent: context.state.agent,
    sessionAgent: (sessionID) => data.session.get(sessionID)?.agent,
    async prompt(sessionID, text, options) {
      if (!data.session.get(sessionID)) await data.session.sync(sessionID)
      // The composer's agent is only a local pick until a prompt commits it, as typing would.
      const agent = local.agent.current()?.id
      if (options.switchAgent && agent && data.session.get(sessionID)?.agent !== agent)
        await client.api.session.switchAgent({ sessionID, agent })
      const gate = voiced.has(sessionID)
        ? undefined
        : client.api.session
            .synthetic({ sessionID, text: VOICE_MODE_SYSTEM_PROMPT, resume: false })
            .then(() => void voiced.add(sessionID))
            .catch(() => undefined)
      await data.session.prompt({ sessionID, text, gate })
    },
    permission(sessionID) {
      const family = [sessionID, ...data.session.family(sessionID).filter((id) => id !== sessionID)]
      return family.flatMap((id) => data.session.permission.list(id) ?? [])[0]
    },
    // Reply to the session that asked: a subagent's request lives on its child session.
    reply: (request, decision, message) =>
      data.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision, message }),
    summary,
    lastResponse,
    async repositories() {
      const scanned = await DispatchRpc.optional(context.client, "gitRepos.list", { root: root() }, root())
      return [
        ...context.state.dashboard.agents().flatMap((agent) => {
          const directory = DispatchModel.agentDirectory(agent, root())
          return agent.worktree ? [directory, agent.worktree.sourceRepo] : [directory]
        }),
        ...data.project.list().flatMap((project) => (project.vcs ? [project.canonical] : [])),
        ...(scanned?.repos ?? []),
      ]
    },
    createAgent: (input) =>
      createDirectoryAgent(createHost(), input).then((created) => ({ sessionID: created.entry.sessionID })),
    createWorktree: (input) =>
      createWorktreeAgent(createHost(), input).then((created) => ({ sessionID: created.entry.sessionID })),
  }
  const commands = createCommandDispatcher(host)

  // Interrupt handler: fires even while the main STT is muted (during TTS).
  // Only the wake word "jarvis" is used — common words like "stop" would
  // trigger on Jarvis's own voice since there's no echo cancellation.
  // Saying "Jarvis" kills playback; once TTS stops the mute gate lifts and
  // the next spoken phrase flows through onUtterance normally.
  stt.onInterrupt(() => {
    if (voice.mode() !== "on") return
    tts.stop()
    voice.setStatus("listening")
  })

  stt.onUtterance((text) => {
    if (voice.mode() !== "on") return
    void (async () => {
      // Bare replies first (permissions, answers to Jarvis's questions — no wake word).
      if (await commands.handleBareUtterance(text)) return chime(questionSoundPath, HEARD_MUTE_MS)
      // Then wake-word commands. Only chime on the wake word, so background
      // noise and non-commands stay silent.
      if (/^jarvis\b/i.test(text.trim())) chime(questionSoundPath, HEARD_MUTE_MS)
      await commands.handleUtterance(text)
    })().catch((error: unknown) => toast.show({ variant: "error", title: "Jarvis", message: errorMessage(error) }))
  })

  // The one place the microphone follows the mode. The palette command and the
  // spoken "Jarvis, off" both just set the flag.
  onCleanup(
    voice.onChange((mode) => {
      if (mode === "off") {
        tts.stop()
        void stt.stop()
        // The voice instruction stays in each session's history, so say it no longer applies.
        voiced.forEach((sessionID) => {
          void client.api.session
            .synthetic({ sessionID, text: VOICE_MODE_ENDED_PROMPT, resume: false })
            .catch(() => undefined)
        })
        voiced.clear()
        return
      }
      void turnOn()
    }),
  )

  async function turnOn() {
    const missing = missingModels()
    if (missing.length) {
      voice.setMode("off", { quiet: true })
      return offerDownload(missing)
    }
    const failure = await stt.start()
    if (failure) {
      // Announcing "online" when the mic never opened is worse than silence —
      // it reports a working state that doesn't exist.
      voice.setMode("off", { quiet: true })
      return toast.show({ variant: "error", title: "Jarvis", message: failure, duration: 8000 })
    }
    // Turned off again while the models were loading.
    if (voice.mode() !== "on") return stt.stop()
    toast.show({ variant: "success", message: "Voice mode on", duration: 2000 })
    await tts.init()
    if (voice.mode() === "on") await tts.speak("Jarvis online.")
  }

  // The models are large, so they are fetched only when the user says so.
  async function offerDownload(missing: string[]) {
    const ok = await context.ui.dialog.confirm({
      title: "Jarvis needs speech models",
      message: `Missing in ${paths.format(MODELS_DIR)}: ${missing.join(", ")}. Download them now?`,
      label: { confirm: "Download" },
    })
    if (!ok) return toast.show({ variant: "info", title: "Jarvis", message: "Voice mode needs the speech models" })
    toast.show({ variant: "info", title: "Jarvis", message: "Downloading speech models…", duration: 10000 })
    await downloadModels()
      .then(() => voice.setMode("on"))
      .catch((error: unknown) => toast.show({ variant: "error", title: "Jarvis", message: errorMessage(error) }))
  }

  const disposers = [
    // Agents finishing: in the open session read the reply; elsewhere speak the agent's summary.
    context.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      if (voice.mode() !== "on" || data.session.root(sessionID) !== sessionID) return
      const current = focus()
      if (current.type === "session" && current.root === sessionID) {
        void lastResponse(sessionID).then((text) => (text ? tts.speak(text.substring(0, 2000)) : undefined))
        return
      }
      const agent = agentFor(sessionID)
      if (!agent) return
      void summary(sessionID).then((text) =>
        tts.speak(text ? `${agent.name}: ${text}` : `${agent.name} is waiting for you.`),
      )
    }),
    // Permission prompts in the open session or any dashboard agent are read out.
    context.data.on("permission.asked", (event) => {
      if (voice.mode() !== "on") return
      const rootID = data.session.root(event.data.sessionID)
      const agent = agentFor(rootID)
      const current = focus()
      if (!agent && !(current.type === "session" && current.root === rootID)) return
      const title = permissionPresentation(
        { action: event.data.action, resources: event.data.resources, metadata: event.data.metadata },
        paths.format,
      ).title
      void tts.speak(agent ? `${agent.name} needs permission: ${title}.` : `Permission needed: ${title}.`)
    }),
  ]

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "jarvis.toggle",
        title: voice.mode() === "on" ? "Turn Jarvis voice mode off" : "Turn Jarvis voice mode on",
        group: "Jarvis",
        palette: true,
        slash: { name: "jarvis" },
        run: () => voice.toggle(),
      },
      {
        id: "jarvis.help",
        title: "Show Jarvis voice commands",
        group: "Jarvis",
        palette: true,
        run: () => showVoiceHelp(context),
      },
    ],
  }))

  onCleanup(() => {
    disposers.forEach((dispose) => dispose())
    voice.setMode("off", { quiet: true })
    stt.dispose()
    tts.dispose()
  })

  return <VoiceIndicator context={context} voice={voice} />
}
