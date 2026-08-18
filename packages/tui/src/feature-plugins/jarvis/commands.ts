import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { VoiceState } from "./voice-state"
import type { TTS } from "./tts.js"
import { VOICE_MODE_SYSTEM_PROMPT } from "./voice-prompt"

type CommandMatch = {
  command: string
  args: Record<string, string>
}

type AgentEntry = {
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

/**
 * The command table is the single source of truth for both parsing and the
 * palette's help view, so the documented phrasings can never drift from what
 * the parser actually accepts. Entries without `help` are alternate phrasings
 * of the entry above them and are folded into its description.
 */
const COMMAND_PATTERNS: Array<{
  pattern: RegExp
  command: string
  extract: (match: RegExpMatchArray) => Record<string, string>
  help?: { phrase: string; description: string; category: string }
}> = [
  {
    pattern: /^go\s+(?:to|into)\s+(.+)$/i,
    command: "navigate",
    extract: (m) => ({ target: m[1]!.trim() }),
    help: {
      phrase: "Jarvis, go to <agent>",
      description: 'Open that agent\'s session. Also "open <agent>".',
      category: "Navigation",
    },
  },
  {
    pattern: /^open\s+(.+)$/i,
    command: "navigate",
    extract: (m) => ({ target: m[1]!.trim() }),
  },
  {
    pattern: /^(?:go\s+)?home$|^dashboard$/i,
    command: "go-home",
    extract: () => ({}),
    help: {
      phrase: "Jarvis, go home",
      description: 'Return to the dashboard. Also "dashboard".',
      category: "Navigation",
    },
  },
  {
    pattern: /^message\s+(.+?)\s*[,]\s*(.+)$/i,
    command: "message",
    extract: (m) => ({ target: m[1]!.trim(), text: m[2]!.trim() }),
    help: {
      phrase: "Jarvis, message <agent>, <text>",
      description: "Open that agent and send it the text after the comma.",
      category: "Navigation",
    },
  },
  {
    pattern: /^create\s+agent\s+called\s+(.+?)\s+on\s+(.+)$/i,
    command: "create-agent",
    extract: (m) => ({ name: m[1]!.trim(), repo: m[2]!.trim() }),
    help: {
      phrase: "Jarvis, create agent called <name> on <repo>",
      description: "Create an agent in that repo and open it.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+agent\s+on\s+(.+)$/i,
    command: "create-agent-nameless",
    extract: (m) => ({ repo: m[1]!.trim() }),
    help: {
      phrase: "Jarvis, create agent on <repo>",
      description: "Same, but Jarvis asks for the name out loud.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+worktree\s+called\s+(.+?)\s+on\s+(.+)$/i,
    command: "create-worktree",
    extract: (m) => ({ name: m[1]!.trim(), repo: m[2]!.trim() }),
    help: {
      phrase: "Jarvis, create worktree called <name> on <repo>",
      description: "Create a worktree agent on a new branch.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+worktree\s+on\s+(.+)$/i,
    command: "create-worktree-nameless",
    extract: (m) => ({ repo: m[1]!.trim() }),
    help: {
      phrase: "Jarvis, create worktree on <repo>",
      description: "Same, but Jarvis asks for the name out loud.",
      category: "Create",
    },
  },
  {
    // Anchored so it only fires on the bare phrase — "Jarvis, plan the
    // migration" stays dictation rather than becoming a mode switch.
    // "yellow"/"solo" are here because the recognizer has no "yolo" in its
    // vocabulary and reliably substitutes a real word for it.
    pattern: /^(?:switch(?:ed)?\s+(?:to|a)\s+|use\s+)?(build|plan|yolo|yellow|solo)(?:\s+mode)?$/i,
    command: "set-agent",
    extract: (m) => ({ agent: m[1]!.toLowerCase() }),
    help: {
      phrase: "Jarvis, plan mode",
      description: 'Switch the agent to build, plan, or yolo. Also "switch to build".',
      category: "Session",
    },
  },
  {
    pattern: /^(?:what\s+)?mode\s+(?:am\s+i\s+in|is\s+this)\??$/i,
    command: "which-agent",
    extract: () => ({}),
    help: {
      phrase: "Jarvis, what mode am I in?",
      description: "Speak the current agent.",
      category: "Session",
    },
  },
  {
    pattern: /^what\s+did\s+(?:it|he|she|they)\s+say\??$/i,
    command: "summarize-last",
    extract: () => ({}),
    help: {
      phrase: "Jarvis, what did it say?",
      description: "Speak the summary for this session. On the dashboard, Jarvis asks which agent.",
      category: "Speech",
    },
  },
  {
    // "it/he/she/they" is handled above; anything else is an agent name, which
    // is the only way to ask for a summary from the dashboard in one breath.
    pattern: /^what\s+did\s+(.+?)\s+say\??$/i,
    command: "summarize-last",
    extract: (m) => ({ target: m[1]!.trim() }),
    help: {
      phrase: "Jarvis, what did <agent> say?",
      description: "Speak a named agent's summary from anywhere.",
      category: "Speech",
    },
  },
  {
    pattern: /^(?:read\s+(?:that|it\s+back)|repeat\s+that|say\s+(?:that|it)\s+again)$/i,
    command: "read-last",
    extract: () => ({}),
    help: {
      phrase: "Jarvis, read that",
      description: 'Read the last response verbatim. Also "read it back", "repeat that", "say that again".',
      category: "Speech",
    },
  },
  {
    pattern: /^(?:voice\s+mode\s*)?off$/i,
    command: "voice-off",
    extract: () => ({}),
    help: {
      phrase: "Jarvis, off",
      description: 'Turn voice mode off. Also "voice mode off".',
      category: "Speech",
    },
  },
]

export type VoiceCommandHelp = { phrase: string; description: string; category: string }

/** Spoken commands, for the palette's help view. */
export const VOICE_COMMANDS: VoiceCommandHelp[] = COMMAND_PATTERNS.flatMap((entry) =>
  entry.help ? [entry.help] : [],
)

/**
 * Replies accepted without the wake word, because the context makes them
 * unambiguous. Not part of COMMAND_PATTERNS — these are handled by
 * handleBareUtterance, which only runs when something is actually pending.
 */
export const BARE_COMMANDS: VoiceCommandHelp[] = [
  {
    phrase: "approve",
    description: 'Allow a pending permission once. Also "yes", "allow", "accept", "ok".',
    category: "Permission (no wake word)",
  },
  {
    phrase: "always",
    description: "Allow this permission and stop asking.",
    category: "Permission (no wake word)",
  },
  {
    phrase: "deny",
    description: 'Reject it; Jarvis then asks why. Also "no", "reject".',
    category: "Permission (no wake word)",
  },
  {
    phrase: "deny, <reason>",
    description: "Reject with the reason in one breath.",
    category: "Permission (no wake word)",
  },
]

/**
 * Fixed phrases matched by edit distance after the regexes miss, because the
 * recognizer mishears short words ("what mode am I in" arrives as "what mot am
 * i in") and an unmatched command silently becomes dictation — so a single
 * wrong phoneme sends a garbage prompt to the agent.
 *
 * Only argument-less phrases belong here, and only ones long enough to be
 * distinctive: "plan mode" is one edit from "plan more", so short phrases
 * would hijack dictation. Those stay exact-match via the regexes above.
 */
const FUZZY_PHRASES: Array<{ phrase: string; command: string; args?: Record<string, string> }> = [
  { phrase: "what mode am i in", command: "which-agent" },
  { phrase: "what mode is this", command: "which-agent" },
  { phrase: "what did it say", command: "summarize-last" },
  { phrase: "go to the dashboard", command: "go-home" },
  { phrase: "switch to build mode", command: "set-agent", args: { agent: "build" } },
  { phrase: "switch to plan mode", command: "set-agent", args: { agent: "plan" } },
  { phrase: "switch to yolo mode", command: "set-agent", args: { agent: "yolo" } },
  { phrase: "switch to yellow mode", command: "set-agent", args: { agent: "yolo" } },
]

function parseCommand(text: string): CommandMatch | undefined {
  for (const { pattern, command, extract } of COMMAND_PATTERNS) {
    const match = text.match(pattern)
    if (match) return { command, args: extract(match) }
  }

  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()

  let best: { command: string; args: Record<string, string>; distance: number } | undefined
  for (const { phrase, command, args } of FUZZY_PHRASES) {
    // Tolerance scales with length so a long phrase survives one misheard
    // word. Below 12 characters the edit budget is large enough relative to
    // the phrase that real dictation starts matching, so those are skipped.
    if (phrase.length < 12) continue
    const allowed = Math.floor(phrase.length * 0.25)
    const distance = levenshtein(normalized, phrase)
    if (distance <= allowed && (!best || distance < best.distance)) {
      best = { command, args: args ?? {}, distance }
    }
  }

  return best ? { command: best.command, args: best.args } : undefined
}

function toCamelCase(spoken: string): string {
  return spoken
    .toLowerCase()
    .split(/\s+/)
    .map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("")
}

function normalizeForMatch(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .trim()
}

function fuzzyMatchName(spoken: string, candidates: Array<{ name: string; id: string }>): string | undefined {
  const normalized = normalizeForMatch(spoken)
  let bestScore = Infinity
  let bestID: string | undefined

  for (const candidate of candidates) {
    const candidateNorm = normalizeForMatch(candidate.name)
    if (candidateNorm === normalized) return candidate.id
    if (candidateNorm.includes(normalized) || normalized.includes(candidateNorm)) {
      const score = Math.abs(candidateNorm.length - normalized.length)
      if (score < bestScore) {
        bestScore = score
        bestID = candidate.id
      }
    }
  }

  if (bestID) return bestID

  for (const candidate of candidates) {
    const candidateNorm = normalizeForMatch(candidate.name)
    const distance = levenshtein(normalized, candidateNorm)
    if (distance <= Math.max(2, Math.floor(candidateNorm.length * 0.3)) && distance < bestScore) {
      bestScore = distance
      bestID = candidate.id
    }
  }

  return bestID
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}

function fuzzyMatchRepo(spoken: string, directories: string[]): string | undefined {
  const unique = [...new Set(directories)]
  const candidates = unique.map((dir) => {
    const basename = dir.split("/").pop() ?? dir
    return { name: basename, id: dir }
  })
  return fuzzyMatchName(spoken, candidates)
}

function getAgents(api: TuiPluginApi): AgentEntry[] {
  return (api.kv.get("agents", []) as AgentEntry[]) ?? []
}

function getRepoDirectories(api: TuiPluginApi): string[] {
  const agents = getAgents(api)
  return [...new Set(agents.map((a) => a.directory).filter(Boolean) as string[])]
}

export type CommandDispatcher = {
  handleUtterance: (text: string) => Promise<void>
  handleBareUtterance: (text: string) => Promise<boolean>
}

export function createCommandDispatcher(
  api: TuiPluginApi,
  voiceState: VoiceState,
  tts: TTS,
): CommandDispatcher {
  async function navigateToAgent(target: string) {
    const agents = getAgents(api)
    const candidates = agents.map((a) => ({ name: a.name, id: a.id }))
    const matchedID = fuzzyMatchName(target, candidates)

    if (!matchedID) {
      await tts.speak(`I don't recognize an agent called ${target}.`)
      return
    }

    const agent = agents.find((a) => a.id === matchedID)
    if (!agent) return
    api.route.navigate("session", { sessionID: agent.sessionID })
  }

  async function handleCommand(cmd: CommandMatch) {
    switch (cmd.command) {
      case "navigate": {
        await navigateToAgent(cmd.args.target!)
        break
      }
      case "go-home": {
        api.route.navigate("home")
        break
      }
      case "message": {
        const agents = getAgents(api)
        const candidates = agents.map((a) => ({ name: a.name, id: a.id }))
        const matchedID = fuzzyMatchName(cmd.args.target!, candidates)
        if (!matchedID) {
          await tts.speak(`I don't recognize an agent called ${cmd.args.target}.`)
          return
        }
        const agent = agents.find((a) => a.id === matchedID)
        if (!agent) return
        api.route.navigate("session", { sessionID: agent.sessionID })
        void api.client.session.prompt({
          sessionID: agent.sessionID,
          parts: [{ type: "text", text: cmd.args.text! }],
          agent: api.state.agent.current(),
          system: voiceState.mode() === "on" ? VOICE_MODE_SYSTEM_PROMPT : undefined,
        })
        break
      }
      case "create-agent": {
        const dir = fuzzyMatchRepo(cmd.args.repo!, getRepoDirectories(api))
        if (!dir) {
          await tts.speak(`I don't recognize a repo called ${cmd.args.repo}.`)
          return
        }
        const name = toCamelCase(cmd.args.name!)
        const result = await api.client.session.create({ directory: dir })
        if (!result.data) return
        api.kv.set("agents", [...getAgents(api), { id: crypto.randomUUID(), name, sessionID: result.data.id, createdAt: Date.now(), directory: dir }])
        api.route.navigate("session", { sessionID: result.data.id })
        await tts.speak(`Created agent ${cmd.args.name} on ${dir.split("/").pop()}.`)
        break
      }
      case "create-agent-nameless": {
        const dir = fuzzyMatchRepo(cmd.args.repo!, getRepoDirectories(api))
        if (!dir) {
          await tts.speak(`I don't recognize a repo called ${cmd.args.repo}.`)
          return
        }
        await tts.speak("What should I name it?")
        const name = await voiceState.waitForResponse("agent-name")
        if (!name) {
          await tts.speak("Timed out waiting for a name.")
          return
        }
        const camelName = toCamelCase(name)
        const result = await api.client.session.create({ directory: dir })
        if (!result.data) return
        api.kv.set("agents", [...getAgents(api), { id: crypto.randomUUID(), name: camelName, sessionID: result.data.id, createdAt: Date.now(), directory: dir }])
        api.route.navigate("session", { sessionID: result.data.id })
        await tts.speak(`Created agent ${name} on ${dir.split("/").pop()}.`)
        break
      }
      case "create-worktree": {
        const dir = fuzzyMatchRepo(cmd.args.repo!, getRepoDirectories(api))
        if (!dir) {
          await tts.speak(`I don't recognize a repo called ${cmd.args.repo}.`)
          return
        }
        const name = toCamelCase(cmd.args.name!)
        const worktree = await api.client.worktree.create({ directory: dir, worktreeCreateInput: { name } })
        if (!worktree.data) return
        const session = await api.client.session.create({ directory: worktree.data.directory })
        if (!session.data) return
        api.kv.set("agents", [
          ...getAgents(api),
          {
            id: crypto.randomUUID(),
            name,
            sessionID: session.data.id,
            createdAt: Date.now(),
            directory: dir,
            worktree: { branch: worktree.data.branch ?? name, directory: worktree.data.directory, sourceRepo: dir },
          },
        ])
        api.route.navigate("session", { sessionID: session.data.id })
        await tts.speak(`Created worktree agent ${cmd.args.name} on ${dir.split("/").pop()}.`)
        break
      }
      case "create-worktree-nameless": {
        const dir = fuzzyMatchRepo(cmd.args.repo!, getRepoDirectories(api))
        if (!dir) {
          await tts.speak(`I don't recognize a repo called ${cmd.args.repo}.`)
          return
        }
        await tts.speak("What should I name it?")
        const name = await voiceState.waitForResponse("agent-name")
        if (!name) {
          await tts.speak("Timed out waiting for a name.")
          return
        }
        const camelName = toCamelCase(name)
        const worktree = await api.client.worktree.create({ directory: dir, worktreeCreateInput: { name: camelName } })
        if (!worktree.data) return
        const session = await api.client.session.create({ directory: worktree.data.directory })
        if (!session.data) return
        api.kv.set("agents", [
          ...getAgents(api),
          {
            id: crypto.randomUUID(),
            name: camelName,
            sessionID: session.data.id,
            createdAt: Date.now(),
            directory: dir,
            worktree: { branch: worktree.data.branch ?? camelName, directory: worktree.data.directory, sourceRepo: dir },
          },
        ])
        api.route.navigate("session", { sessionID: session.data.id })
        await tts.speak(`Created worktree agent ${name} on ${dir.split("/").pop()}.`)
        break
      }
      case "summarize-last": {
        const agents = getAgents(api)
        const route = api.route.current
        const target = cmd.args.target

        // Resolve which agent to summarize: an explicit name wins, then the
        // open session, then — on the dashboard, where nothing is implied —
        // ask, unless there is only one agent and the answer is obvious.
        let agent: AgentEntry | undefined
        if (target) {
          const id = fuzzyMatchName(target, agents)
          agent = agents.find((a) => a.id === id)
          if (!agent) {
            await tts.speak(`I don't recognize an agent called ${target}.`)
            break
          }
        } else if (route.name === "session" && route.params) {
          const sid = route.params.sessionID as string
          agent = agents.find((a) => a.sessionID === sid)
        } else if (api.state.home.selectedSessionID()) {
          // On the dashboard, "it" means the row under the cursor — that's the
          // agent you're looking at while you ask.
          agent = agents.find((a) => a.sessionID === api.state.home.selectedSessionID())
        } else if (agents.length === 1) {
          agent = agents[0]
        } else if (agents.length === 0) {
          await tts.speak("There are no agents yet.")
          break
        } else {
          await tts.speak("Which agent?")
          const answer = await voiceState.waitForResponse("agent-name")
          if (!answer) {
            await tts.speak("Never mind.")
            break
          }
          const id = fuzzyMatchName(answer, agents)
          agent = agents.find((a) => a.id === id)
          if (!agent) {
            await tts.speak(`I don't recognize an agent called ${answer}.`)
            break
          }
        }

        if (!agent?.summary?.text) {
          await tts.speak(agent ? `${agent.name} has no summary yet.` : "No summary available.")
          break
        }
        // Name it when the summary wasn't about the session you're looking at,
        // otherwise you can't tell which agent just spoke.
        const spoken = route.name === "session" && !target ? agent.summary.text : `${agent.name}: ${agent.summary.text}`
        await tts.speak(spoken)
        break
      }
      case "set-agent": {
        const spokenAgent = cmd.args.agent!
        const target = spokenAgent === "yellow" || spokenAgent === "solo" ? "yolo" : spokenAgent
        // Agents are configurable, so build/plan/yolo are not guaranteed to
        // exist. Check before setting — local.agent.set only shows a visual
        // toast on a miss, which is invisible when you're not looking.
        const available = api.state.agent.list()
        const match = available.find((name) => name.toLowerCase() === target)
        if (!match) {
          await tts.speak(`There's no ${target} agent here. Available: ${available.join(", ")}.`)
          break
        }
        api.state.agent.set(match)
        await tts.speak(`${match} mode.`)
        break
      }

      case "which-agent": {
        const current = api.state.agent.current()
        await tts.speak(current ? `You're in ${current} mode.` : "No agent is selected.")
        break
      }

      case "read-last": {
        const route = api.route.current
        if (route.name !== "session" || !route.params) {
          await tts.speak("You're not in a session.")
          break
        }
        const sid = route.params.sessionID as string
        const messages = api.state.session.messages(sid)
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
        if (!lastAssistant) {
          await tts.speak("No assistant message found.")
          break
        }
        const parts = api.state.part(lastAssistant.id)
        const text = parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join(" ")
          .trim()
        if (text) {
          await tts.speak(text.substring(0, 2000))
        } else {
          await tts.speak("The last message has no text content.")
        }
        break
      }
      case "voice-off": {
        voiceState.setMode("off")
        break
      }
    }
  }

  async function handleUtterance(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    // Check if we're waiting for a response (no wake word needed)
    const pendingResp = voiceState.pending()
    if (pendingResp) {
      pendingResp.resolve(trimmed)
      return
    }

    // Must start with "Jarvis"
    const jarvisMatch = trimmed.match(/^jarvis\s*[,.]?\s*(.*)$/i)
    if (!jarvisMatch) return

    // The recognizer emits real punctuation, and the command patterns are
    // anchored — without this, "Read that." stops matching "read that".
    // Dictation keeps its punctuation; only the command form is stripped.
    const body = jarvisMatch[1]!.trim()
    const commandBody = body.replace(/[.!?]+$/, "").trim()
    if (!body) return

    const cmd = parseCommand(commandBody)
    if (cmd) {
      await handleCommand(cmd)
      return
    }

    // Fallback: send as prompt to the active session.
    const route = api.route.current
    if (route.name === "session" && route.params) {
      const sessionID = route.params.sessionID as string
      void api.client.session.prompt({
        sessionID,
        parts: [{ type: "text", text: body }],
        agent: api.state.agent.current(),
        system: voiceState.mode() === "on" ? VOICE_MODE_SYSTEM_PROMPT : undefined,
      })
      return
    }

    // On the dashboard there is no session to dictate into, so an unrecognized
    // phrase has nowhere to go. Say so rather than dropping it silently — a
    // misheard command is otherwise indistinguishable from Jarvis not listening.
    await tts.speak(`I didn't catch a command. Say "message" and an agent name to talk to an agent.`)
  }

  // Handle bare utterances (no wake word) — for permissions/questions in session context
  async function handleBareUtterance(text: string): Promise<boolean> {
    // Trailing punctuation stripped for the same reason as above: the
    // recognizer writes "Approve." and these patterns are anchored.
    const trimmed = text.trim().toLowerCase().replace(/[.!?]+$/, "").trim()
    if (!trimmed) return false

    // Check if we're waiting for a response
    const pendingResp = voiceState.pending()
    if (pendingResp) {
      pendingResp.resolve(text.trim())
      return true
    }

    const route = api.route.current
    if (route.name !== "session" || !route.params) return false

    const sessionID = route.params.sessionID as string
    const permissions = api.state.session.permission(sessionID)

    if (permissions.length === 0) return false

    const pending = permissions[0]!

    // Approve patterns
    if (/^(?:approve|yes|allow|accept|ok|okay)$/i.test(trimmed)) {
      await api.client.permission.reply({ requestID: pending.id, reply: "once" })
      return true
    }

    // Always allow
    if (/^(?:always|always\s+allow)$/i.test(trimmed)) {
      await api.client.permission.reply({ requestID: pending.id, reply: "always" })
      return true
    }

    // Deny with reason
    const denyWithReason = trimmed.match(/^(?:deny|no|reject)\s*[,.]?\s*(.+)$/i)
    if (denyWithReason) {
      await api.client.permission.reply({ requestID: pending.id, reply: "reject", message: denyWithReason[1]!.trim() })
      return true
    }

    // Deny without reason — ask for one
    if (/^(?:deny|no|reject)$/i.test(trimmed)) {
      await tts.speak("Why are you denying this?")
      const reason = await voiceState.waitForResponse("deny-reason")
      await api.client.permission.reply({
        requestID: pending.id,
        reply: "reject",
        message: reason || undefined,
      })
      return true
    }

    return false
  }

  return { handleUtterance, handleBareUtterance }
}
