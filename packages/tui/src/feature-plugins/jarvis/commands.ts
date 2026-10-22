import type { DashboardAgent, State } from "@opencode/plugin/tui/context"
import type { VoiceState } from "./voice-state"

export type CommandMatch = {
  command: string
  args: Record<string, string>
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
  help?: VoiceCommandHelp
}> = [
  {
    pattern: /^go\s+(?:to|into)\s+(.+)$/i,
    command: "navigate",
    extract: (m) => ({ target: m[1].trim() }),
    help: {
      phrase: "Jarvis, go to <agent>",
      description: 'Open that agent\'s session. Also "open <agent>".',
      category: "Navigation",
    },
  },
  {
    pattern: /^open\s+(.+)$/i,
    command: "navigate",
    extract: (m) => ({ target: m[1].trim() }),
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
    extract: (m) => ({ target: m[1].trim(), text: m[2].trim() }),
    help: {
      phrase: "Jarvis, message <agent>, <text>",
      description: "Open that agent and send it the text after the comma.",
      category: "Navigation",
    },
  },
  {
    pattern: /^create\s+agent\s+called\s+(.+?)\s+on\s+(.+)$/i,
    command: "create-agent",
    extract: (m) => ({ name: m[1].trim(), repo: m[2].trim() }),
    help: {
      phrase: "Jarvis, create agent called <name> on <repo>",
      description: "Create an agent in that repo and open it.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+agent\s+on\s+(.+)$/i,
    command: "create-agent",
    extract: (m) => ({ repo: m[1].trim() }),
    help: {
      phrase: "Jarvis, create agent on <repo>",
      description: "Same, but Jarvis asks for the name out loud.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+worktree\s+called\s+(.+?)\s+on\s+(.+)$/i,
    command: "create-worktree",
    extract: (m) => ({ name: m[1].trim(), repo: m[2].trim() }),
    help: {
      phrase: "Jarvis, create worktree called <name> on <repo>",
      description: "Create a worktree agent on a new branch.",
      category: "Create",
    },
  },
  {
    pattern: /^create\s+worktree\s+on\s+(.+)$/i,
    command: "create-worktree",
    extract: (m) => ({ repo: m[1].trim() }),
    help: {
      phrase: "Jarvis, create worktree on <repo>",
      description: "Same, but Jarvis asks for the name out loud.",
      category: "Create",
    },
  },
  {
    // Anchored so it only fires on the bare phrase — "Jarvis, build the
    // migration" stays dictation rather than becoming a mode switch.
    // "yellow"/"solo" are here because the recognizer has no "yolo" in its
    // vocabulary and reliably substitutes a real word for it.
    pattern: /^(?:switch(?:ed)?\s+(?:to|a)\s+|use\s+)?(build|yolo|yellow|solo)(?:\s+mode)?$/i,
    command: "set-agent",
    extract: (m) => ({ agent: m[1].toLowerCase() }),
    help: {
      phrase: "Jarvis, yolo mode",
      description: 'Switch the agent to build or yolo. Also "switch to build".',
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
      description: "Speak the summary for this session. On the dashboard, the agent under the cursor.",
      category: "Speech",
    },
  },
  {
    // "it/he/she/they" is handled above; anything else is an agent name, which
    // is the only way to ask for a summary from the dashboard in one breath.
    pattern: /^what\s+did\s+(.+?)\s+say\??$/i,
    command: "summarize-last",
    extract: (m) => ({ target: m[1].trim() }),
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
export const VOICE_COMMANDS: VoiceCommandHelp[] = COMMAND_PATTERNS.flatMap((entry) => (entry.help ? [entry.help] : []))

/**
 * Replies accepted without the wake word, because the context makes them
 * unambiguous. Not part of COMMAND_PATTERNS — these are handled by
 * handleBareUtterance, which only acts when something is actually pending.
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
  { phrase: "switch to yolo mode", command: "set-agent", args: { agent: "yolo" } },
  { phrase: "switch to yellow mode", command: "set-agent", args: { agent: "yolo" } },
]

/** A command body (the text after the wake word) to a command, by regex first and then by edit distance. */
export function parseCommand(text: string): CommandMatch | undefined {
  const exact = COMMAND_PATTERNS.flatMap((entry) => {
    const match = text.match(entry.pattern)
    return match ? [{ command: entry.command, args: entry.extract(match) }] : []
  })[0]
  if (exact) return exact

  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  // Tolerance scales with length so a long phrase survives one misheard word.
  // Below 12 characters the edit budget is large enough relative to the phrase
  // that real dictation starts matching, so those are skipped.
  const best = FUZZY_PHRASES.filter((entry) => entry.phrase.length >= 12)
    .map((entry) => ({ entry, distance: levenshtein(normalized, entry.phrase) }))
    .filter((item) => item.distance <= Math.floor(item.entry.phrase.length * 0.25))
    .sort((a, b) => a.distance - b.distance)[0]
  return best ? { command: best.entry.command, args: best.entry.args ?? {} } : undefined
}

/**
 * The text after a leading "Jarvis", or undefined without the wake word. `command` has trailing
 * punctuation stripped: the recognizer writes "Read that." and the command patterns are anchored.
 * Dictation keeps its punctuation, so `body` is left as spoken.
 */
export function stripWakeWord(text: string) {
  const match = text.trim().match(/^jarvis\s*[,.!?]?\s*(.*)$/i)
  if (!match) return
  const body = match[1].trim()
  if (!body) return
  return { body, command: body.replace(/[.!?]+$/, "").trim() }
}

export type BareReply = { decision: "once" } | { decision: "always" } | { decision: "reject"; reason?: string }

/** A permission answer spoken without the wake word, or undefined when the phrase is not one. */
export function parseBareReply(text: string): BareReply | undefined {
  const trimmed = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .trim()
  if (/^(?:approve|yes|allow|accept|ok|okay)$/.test(trimmed)) return { decision: "once" }
  if (/^always(?:\s+allow)?$/.test(trimmed)) return { decision: "always" }
  if (/^(?:deny|no|reject)$/.test(trimmed)) return { decision: "reject" }
  // A separator is required so "nope" or "notice that" are not a denial.
  const reason = trimmed.match(/^(?:deny|no|reject)(?:\s*[,.]\s*|\s+)(.+)$/)
  if (reason) return { decision: "reject", reason: reason[1].trim() }
}

/** Spoken names become camelCase agent names: "auth refactor" is "authRefactor". */
export function toCamelCase(spoken: string) {
  return spoken
    .toLowerCase()
    .split(/\s+/)
    .map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("")
}

function normalizeForMatch(name: string) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .trim()
}

/**
 * The candidate a spoken name refers to: exact after normalizing camelCase and separators, then the
 * closest containment, then the nearest within an edit budget.
 */
export function fuzzyMatchName<Candidate extends { name: string }>(spoken: string, candidates: readonly Candidate[]) {
  const normalized = normalizeForMatch(spoken)
  const named = candidates.map((candidate) => ({ candidate, name: normalizeForMatch(candidate.name) }))
  const exact = named.find((item) => item.name === normalized)
  if (exact) return exact.candidate
  const contained = named
    .filter((item) => item.name.includes(normalized) || normalized.includes(item.name))
    .sort((a, b) => Math.abs(a.name.length - normalized.length) - Math.abs(b.name.length - normalized.length))[0]
  if (contained) return contained.candidate
  return named
    .map((item) => ({ ...item, distance: levenshtein(normalized, item.name) }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(item.name.length * 0.3)))
    .sort((a, b) => a.distance - b.distance)[0]?.candidate
}

/** A repository directory by its spoken basename. */
export function fuzzyMatchRepo(spoken: string, directories: readonly string[]) {
  const candidates = [...new Set(directories)].map((directory) => ({
    name: directory.replace(/\/+$/, "").split("/").pop() ?? directory,
    directory,
  }))
  return fuzzyMatchName(spoken, candidates)?.directory
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

/** Where the user is looking: the open session (and its root), the dashboard cursor, or neither. */
export type Focus =
  | { readonly type: "session"; readonly sessionID: string; readonly root: string }
  | { readonly type: "dashboard"; readonly selected?: string }
  | { readonly type: "other" }

/** What the dispatcher acts through. index.tsx wires these to the plugin context and the TUI data layer. */
export type CommandHost = {
  voice: Pick<VoiceState, "pending" | "waitForResponse" | "setMode">
  speak: (text: string) => Promise<void>
  focus: () => Focus
  agents: () => readonly DashboardAgent[]
  open: (sessionID: string) => void
  home: () => void
  agent: State["agent"]
  /** The agent a session runs as, which can differ from the composer's pick. */
  sessionAgent: (sessionID: string) => string | undefined
  /** Sends text to a session. `switchAgent` makes the session run as the composer's agent first. */
  prompt: (sessionID: string, text: string, options: { switchAgent: boolean }) => Promise<void>
  /** First pending permission anywhere in the session's family. */
  permission: (sessionID: string) => { readonly id: string; readonly sessionID: string } | undefined
  reply: (
    request: { readonly id: string; readonly sessionID: string },
    decision: BareReply["decision"],
    message?: string,
  ) => Promise<void>
  /** The dashboard summary of the session's last reply. */
  summary: (sessionID: string) => Promise<string | undefined>
  /** The session's last assistant reply, verbatim. */
  lastResponse: (sessionID: string) => Promise<string | undefined>
  repositories: () => Promise<readonly string[]>
  createAgent: (input: { name: string; directory: string }) => Promise<{ sessionID: string }>
  createWorktree: (input: { name: string; repository: string }) => Promise<{ sessionID: string }>
}

export type CommandDispatcher = ReturnType<typeof createCommandDispatcher>

export function createCommandDispatcher(host: CommandHost) {
  const unknownAgent = (name: string) => host.speak(`I don't recognize an agent called ${name}.`)
  const findAgent = (name: string) => fuzzyMatchName(name, host.agents())

  async function create(args: Record<string, string>, kind: "agent" | "worktree") {
    const repository = fuzzyMatchRepo(args.repo, await host.repositories().catch(() => []))
    if (!repository) return host.speak(`I don't recognize a repo called ${args.repo}.`)
    const spoken = args.name ?? (await askName())
    if (!spoken) return host.speak("Timed out waiting for a name.")
    const name = toCamelCase(spoken)
    const label = repository.split("/").pop()
    const created = await (
      kind === "agent" ? host.createAgent({ name, directory: repository }) : host.createWorktree({ name, repository })
    ).then(
      (result) => ({ sessionID: result.sessionID }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    if ("error" in created) return host.speak(`I couldn't create the ${kind}. ${created.error}`)
    host.open(created.sessionID)
    await host.speak(`Created ${kind === "agent" ? "agent" : "worktree agent"} ${spoken} on ${label}.`)
  }

  async function askName() {
    await host.speak("What should I name it?")
    return host.voice.waitForResponse("agent-name")
  }

  async function summarize(target: string | undefined) {
    const focus = host.focus()
    // An explicit name wins, then the open session, then the row under the
    // dashboard cursor, then the only agent; otherwise ask.
    const resolved = target
      ? findAgent(target)
      : focus.type === "session"
        ? (host.agents().find((agent) => agent.sessionID === focus.root) ?? { name: "", sessionID: focus.root })
        : focus.type === "dashboard" && focus.selected
          ? host.agents().find((agent) => agent.sessionID === focus.selected)
          : host.agents().length === 1
            ? host.agents()[0]
            : undefined
    if (target && !resolved) return unknownAgent(target)
    if (!resolved && host.agents().length === 0) return host.speak("There are no agents yet.")
    const agent = resolved ?? (await askAgent())
    if (!agent) return
    const summary = await host.summary(agent.sessionID)
    if (!summary) return host.speak(agent.name ? `${agent.name} has no summary yet.` : "No summary available.")
    // Name it when the summary wasn't about the session you're looking at,
    // otherwise you can't tell which agent just spoke.
    await host.speak(focus.type === "session" && !target ? summary : `${agent.name}: ${summary}`)
  }

  async function askAgent() {
    await host.speak("Which agent?")
    const answer = await host.voice.waitForResponse("agent-name")
    if (!answer) return void (await host.speak("Never mind."))
    const agent = findAgent(answer)
    if (!agent) return void (await unknownAgent(answer))
    return agent
  }

  async function handleCommand(cmd: CommandMatch) {
    if (cmd.command === "navigate") {
      const agent = findAgent(cmd.args.target)
      if (!agent) return unknownAgent(cmd.args.target)
      return host.open(agent.sessionID)
    }
    if (cmd.command === "go-home") return host.home()
    if (cmd.command === "message") {
      const agent = findAgent(cmd.args.target)
      if (!agent) return unknownAgent(cmd.args.target)
      host.open(agent.sessionID)
      // Like the dashboard's message prompt, this keeps the agent's own agent and model.
      return host.prompt(agent.sessionID, cmd.args.text, { switchAgent: false })
    }
    if (cmd.command === "create-agent") return create(cmd.args, "agent")
    if (cmd.command === "create-worktree") return create(cmd.args, "worktree")
    if (cmd.command === "summarize-last") return summarize(cmd.args.target)
    if (cmd.command === "set-agent") {
      const spoken = cmd.args.agent === "yellow" || cmd.args.agent === "solo" ? "yolo" : cmd.args.agent
      // Agents are configurable, so build/yolo are not guaranteed to
      // exist. Check before setting: the miss is otherwise only a visual toast,
      // which is invisible when you're not looking.
      const available = host.agent.list()
      const match = available.find((id) => id.toLowerCase() === spoken)
      if (!match) return host.speak(`There's no ${spoken} agent here. Available: ${available.join(", ")}.`)
      host.agent.set(match)
      return host.speak(`${match} mode.`)
    }
    if (cmd.command === "which-agent") {
      // The composer's pick first: "yolo mode" changes it, and the next prompt commits it to the session.
      const focus = host.focus()
      const current =
        host.agent.current() ?? (focus.type === "session" ? host.sessionAgent(focus.sessionID) : undefined)
      return host.speak(current ? `You're in ${current} mode.` : "No agent is selected.")
    }
    if (cmd.command === "read-last") {
      const focus = host.focus()
      if (focus.type !== "session") return host.speak("You're not in a session.")
      const text = await host.lastResponse(focus.sessionID)
      return host.speak(text ? text.substring(0, 2000) : "No assistant message found.")
    }
    if (cmd.command === "voice-off") return host.voice.setMode("off")
  }

  /** A transcribed phrase that starts with the wake word: a command, else dictation into the open session. */
  async function handleUtterance(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    // An answer to a question Jarvis asked needs no wake word.
    const pending = host.voice.pending()
    if (pending) return pending.resolve(trimmed)

    const spoken = stripWakeWord(trimmed)
    if (!spoken) return
    const cmd = parseCommand(spoken.command)
    if (cmd) return handleCommand(cmd)

    const focus = host.focus()
    if (focus.type === "session") return host.prompt(focus.sessionID, spoken.body, { switchAgent: true })
    // Outside a session an unrecognized phrase has nowhere to go. Say so rather
    // than dropping it: a misheard command is otherwise indistinguishable from
    // Jarvis not listening.
    await host.speak(`I didn't catch a command. Say "message" and an agent name to talk to an agent.`)
  }

  /**
   * A phrase without the wake word: an answer Jarvis asked for, or a reply to the permission pending
   * in the open session or on the dashboard row under the cursor. True when it was consumed.
   */
  async function handleBareUtterance(text: string) {
    if (!text.trim()) return false
    const pending = host.voice.pending()
    if (pending) {
      pending.resolve(text.trim())
      return true
    }
    const reply = parseBareReply(text)
    if (!reply) return false
    const focus = host.focus()
    const sessionID = focus.type === "session" ? focus.root : focus.type === "dashboard" ? focus.selected : undefined
    const request = sessionID ? host.permission(sessionID) : undefined
    if (!request) return false
    if (reply.decision !== "reject" || reply.reason) {
      await host.reply(request, reply.decision, reply.decision === "reject" ? reply.reason : undefined)
      return true
    }
    await host.speak("Why are you denying this?")
    const reason = await host.voice.waitForResponse("deny-reason")
    await host.reply(request, "reject", reason || undefined)
    return true
  }

  return { handleUtterance, handleBareUtterance }
}
