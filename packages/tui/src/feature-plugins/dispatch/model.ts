export * as DispatchModel from "./model"

import path from "path"
import type { FormInfo, PermissionRequest, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { DispatchRpc } from "./rpc"

/** One row on the agent dashboard. The session title carries the same name. */
export type AgentEntry = {
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
}

export type AgentSummary = {
  text: string
  /** The server summarized a long reply with a model. */
  ai: boolean
}

export const PLUGIN_ID = "dispatch"

// The dashboard's durable list lives in TUI storage (plugin keys are prefixed `plugin.<id>.`).
// context/session-tabs.tsx reads the same key to keep agent transcripts out of eviction.
export const AGENTS_KEY = "agents"
export const AGENTS_STORAGE_KEY = `plugin.${PLUGIN_ID}.${AGENTS_KEY}`
export type AgentsState = { agents: AgentEntry[] }
export const emptyAgents = (): AgentsState => ({ agents: [] })

export const SUMMARIES_KEY = "summaries"
export type SummariesState = { visible: boolean; bySession: Record<string, AgentSummary> }
export const emptySummaries = (): SummariesState => ({ visible: true, bySession: {} })

// Client-local dashboard state shared by the route, the background watcher and the plugin state API.
export const STATE_KEY = "state"
export const STATE_MEMORY_KEY = `plugin.${PLUGIN_ID}.${STATE_KEY}`
export type DashboardState = {
  /** Session under the dashboard cursor. */
  selected?: string
  /** Session the user last opened from the dashboard; the cursor returns to it. */
  lastEntered?: string
  /** Diffstat per agent directory. */
  diffstats: Record<string, DispatchRpc.DiffStat>
  /** Pull request per worktree branch; "error" when the lookup failed. */
  prs: Record<string, DispatchRpc.PullRequest | null | "error">
  /** Whether `gh` is authenticated on the server; undefined until known or when unsupported. */
  github?: boolean
  /** Sessions mirrored to claude.ai. */
  remote: string[]
}
export const emptyState = (): DashboardState => ({ diffstats: {}, prs: {}, remote: [] })

/**
 * Session.metadata key stamped on an agent's session at creation, so other clients can tell it is a
 * Dispatch agent. Children and forks inherit metadata, so the entry names the session it belongs to.
 */
export const METADATA_KEY = "dispatch.agent"

export function agentMetadata(entry: Pick<AgentEntry, "name" | "createdAt" | "worktree">, sessionID: string) {
  return {
    [METADATA_KEY]: {
      sessionID,
      name: entry.name,
      createdAt: entry.createdAt,
      ...(entry.worktree ? { worktree: { ...entry.worktree } } : {}),
    },
  }
}

/** The agent stamp on a session, ignoring one inherited from a parent or fork source. */
export function readAgentMetadata(session: Pick<SessionInfo, "id" | "metadata">) {
  const value = session.metadata?.[METADATA_KEY]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (value.sessionID !== session.id || typeof value.name !== "string") return
  return { name: value.name, createdAt: typeof value.createdAt === "number" ? value.createdAt : undefined }
}

/** Directory an agent works in: its worktree, else its own directory, else the launch directory. */
export function agentDirectory(agent: AgentEntry, fallback: string) {
  const dir = agent.worktree
    ? agent.worktree.directory
    : !agent.directory || agent.directory === "."
      ? fallback
      : path.isAbsolute(agent.directory)
        ? agent.directory
        : path.join(fallback, agent.directory)
  return dir.replace(/\/+$/, "") || "/"
}

export type AgentGroup<Agent extends AgentEntry = AgentEntry> = {
  directory: string
  agents: Agent[]
}

/** Agents grouped by directory, keeping first-seen group order and list order inside a group. */
export function groupAgents<Agent extends AgentEntry>(agents: readonly Agent[], fallback: string) {
  return agents.reduce<AgentGroup<Agent>[]>((groups, agent) => {
    const directory = agentDirectory(agent, fallback)
    const group = groups.find((item) => item.directory === directory)
    if (group) group.agents.push(agent)
    else groups.push({ directory, agents: [agent] })
    return groups
  }, [])
}

/** Inserts after the last agent sharing the directory, so groups stay contiguous. */
export function insertAgent(agents: readonly AgentEntry[], entry: AgentEntry, fallback: string) {
  const directory = agentDirectory(entry, fallback)
  const last = agents.findLastIndex((agent) => agentDirectory(agent, fallback) === directory)
  const index = last === -1 ? agents.length : last + 1
  return { agents: [...agents.slice(0, index), entry, ...agents.slice(index)], index }
}

const SYMBOLS = "!@#$%^&*()"

/** Row label: 1-9, then 0, then the shifted digits. */
export function hotkey(index: number) {
  const n = index + 1
  if (n <= 9) return String(n)
  if (n === 10) return "0"
  if (n <= 20) return SYMBOLS[n - 11]
  return ""
}

export type PendingRequest =
  | { readonly type: "permission"; readonly request: PermissionRequest }
  | { readonly type: "form"; readonly form: FormInfo }

/** The first pending permission in the agent's family (root first), else its first form. */
export function pendingRequest(input: {
  family: readonly string[]
  permissions: (sessionID: string) => readonly PermissionRequest[] | undefined
  forms: (sessionID: string) => readonly FormInfo[] | undefined
}): PendingRequest | undefined {
  const request = input.family.flatMap((id) => input.permissions(id) ?? [])[0]
  if (request) return { type: "permission", request }
  const form = input.family.flatMap((id) => input.forms(id) ?? [])[0]
  if (form) return { type: "form", form }
}

export type AgentStatus =
  | { readonly type: "approve"; readonly pending: PendingRequest }
  | { readonly type: "retrying" }
  | { readonly type: "working"; readonly activity?: string }
  | { readonly type: "waiting" }

export const STATUS_LABEL = {
  approve: "Approve (y/n)",
  retrying: "Retrying",
  working: "Working",
  waiting: "Waiting for user",
} as const satisfies Record<AgentStatus["type"], string>

/**
 * Status column for an agent. A pending permission or form anywhere in the family wins, so a
 * subagent waiting on approval surfaces on its root's row.
 */
export function agentStatus(input: {
  root: string
  family: readonly string[]
  permissions: (sessionID: string) => readonly PermissionRequest[] | undefined
  forms: (sessionID: string) => readonly FormInfo[] | undefined
  running: (sessionID: string) => boolean
  messages: (sessionID: string) => readonly SessionMessageInfo[]
}): AgentStatus {
  const family = [input.root, ...input.family.filter((id) => id !== input.root)]
  const pending = pendingRequest({ family, permissions: input.permissions, forms: input.forms })
  if (pending) return { type: "approve", pending }
  const running = family.filter(input.running)
  if (running.length === 0) return { type: "waiting" }
  const assistant = lastAssistant(input.messages(input.root))
  if (input.running(input.root) && assistant?.retry && assistant.time.completed === undefined)
    return { type: "retrying" }
  const activity = running.map((id) => currentActivity(input.messages(id))).find((value) => value !== undefined)
  return { type: "working", activity }
}

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

function lastAssistant(messages: readonly SessionMessageInfo[]) {
  return messages.findLast((message): message is Assistant => message.type === "assistant")
}

/** What the agent is doing right now, e.g. "Shell pwd" or "Thinking…". */
export function currentActivity(messages: readonly SessionMessageInfo[]) {
  const assistant = lastAssistant(messages)
  if (!assistant || assistant.time.completed !== undefined) return
  const part = assistant.content.at(-1)
  if (!part) return
  if (part.type === "reasoning") return part.time?.completed === undefined ? "Thinking…" : undefined
  if (part.type === "text") return "Writing…"
  if (part.state.status === "completed" || part.state.status === "error") return
  return formatActivity(part.name, part.state.status === "streaming" ? undefined : part.state.input)
}

const PATH_FIELDS = ["filePath", "file_path", "filepath", "path"] as const
const TEXT_FIELDS = ["command", "pattern", "query", "url", "prompt", "description"] as const

/** Tool name plus its most telling argument: a file's basename, else the command or pattern. */
export function formatActivity(name: string, input: unknown) {
  const label = name.charAt(0).toUpperCase() + name.slice(1)
  if (!input || typeof input !== "object" || Array.isArray(input)) return label
  const record = input as Record<string, unknown>
  const file = PATH_FIELDS.map((key) => record[key]).find((value) => typeof value === "string" && value)
  if (typeof file === "string") return `${label} ${path.basename(file)}`
  const text = TEXT_FIELDS.map((key) => record[key]).find((value) => typeof value === "string" && value)
  if (typeof text !== "string") return label
  const line = text.split("\n")[0].trim()
  return `${label} ${line.length > 60 ? line.slice(0, 59) + "…" : line}`
}

export type DashboardAction =
  | { readonly type: "move"; readonly delta: 1 | -1 }
  | { readonly type: "jump"; readonly index: number }
  | {
      readonly type:
        | "open"
        | "copy"
        | "add"
        | "worktree"
        | "remove"
        | "purge"
        | "diff"
        | "approve"
        | "deny"
        | "terminal"
        | "message"
        | "refresh"
        | "createPr"
        | "copyPr"
        | "mergePr"
    }

export type DashboardKey = {
  readonly name: string
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly hyper?: boolean
}

const PLAIN: Record<string, DashboardAction> = {
  j: { type: "move", delta: 1 },
  down: { type: "move", delta: 1 },
  k: { type: "move", delta: -1 },
  up: { type: "move", delta: -1 },
  return: { type: "open" },
  enter: { type: "open" },
  c: { type: "copy" },
  a: { type: "add" },
  w: { type: "worktree" },
  d: { type: "remove" },
  x: { type: "purge" },
  y: { type: "approve" },
  n: { type: "deny" },
  t: { type: "terminal" },
  i: { type: "message" },
  r: { type: "refresh" },
  o: { type: "copyPr" },
}

const SHIFTED: Record<string, DashboardAction> = {
  d: { type: "diff" },
  p: { type: "createPr" },
  m: { type: "mergePr" },
}

/**
 * Maps a dashboard keypress to its action. Shifted letters may arrive as `{name: "d", shift: true}`
 * (kitty protocol) or as the bare capital; shifted digits as `{name: "1", shift: true}` or as "!".
 */
export function dashboardAction(key: DashboardKey): DashboardAction | undefined {
  if (key.ctrl || key.meta || key.super || key.hyper) return
  const name = key.name
  if (name.length === 1 && name !== name.toLowerCase()) return SHIFTED[name.toLowerCase()]
  const digit = /^[0-9]$/.test(name) ? (name === "0" ? 9 : Number(name) - 1) : undefined
  if (name.length === 1 && SYMBOLS.includes(name)) return { type: "jump", index: 10 + SYMBOLS.indexOf(name) }
  if (key.shift) {
    if (digit !== undefined) return { type: "jump", index: 10 + digit }
    if (name === "up" || name === "down") return PLAIN[name]
    return SHIFTED[name]
  }
  if (digit !== undefined) return { type: "jump", index: digit }
  return PLAIN[name]
}

/** One line for the PR column, e.g. "PR: #12 Open ✓ CI Approved". */
export function prLabel(pr: DispatchRpc.PullRequest) {
  const state = pr.draft ? "Draft" : pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : "Open"
  const ci = pr.checks === "pass" ? " ✓ CI" : pr.checks === "fail" ? " ✗ CI" : pr.checks === "pending" ? " ⧗ CI" : ""
  const review =
    pr.state !== "OPEN" || pr.draft
      ? ""
      : pr.review === "APPROVED"
        ? " Approved"
        : pr.review === "CHANGES_REQUESTED"
          ? " Changes Requested"
          : pr.review === "REVIEW_REQUIRED"
            ? " Review Required"
            : ""
  return `PR: #${pr.number} ${state}${ci}${review}`
}

/** Why a PR cannot be merged from the dashboard, or undefined when it can. */
export function mergeBlocker(pr: DispatchRpc.PullRequest) {
  if (pr.state !== "OPEN") return `PR is ${pr.state.toLowerCase()}`
  if (pr.checks === "fail") return "PR not ready: CI failing"
  if (pr.review === "CHANGES_REQUESTED") return "PR not ready: changes requested"
}

/** Sums a v2 VCS diff into a diffstat, for servers without the Dispatch diffstat RPC. */
export function diffStat(files: readonly { additions: number; deletions: number }[]): DispatchRpc.DiffStat {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files: files.length,
  }
}
