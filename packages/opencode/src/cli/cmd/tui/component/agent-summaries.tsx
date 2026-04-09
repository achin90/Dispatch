import { produce } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { useKV } from "../context/kv"
import { useSync } from "../context/sync"
import type { AgentEntry } from "@tui/routes/home"

/**
 * Stays mounted across route changes. Listens for session.status idle
 * transitions and fetches last-response summaries, storing them in KV
 * on the matching agent entry.
 */
export function AgentSummaries() {
  const sdk = useSDK()
  const kv = useKV()
  const sync = useSync()
  const fetching = new Set<string>()

  // Load cached summaries from KV into sync store on mount
  const agents: AgentEntry[] = kv.get("agents", [])
  for (const agent of agents) {
    if (agent.summary) {
      sync.set("agent_summary", agent.sessionID, agent.summary)
    }
  }

  sdk.event.on("session.status", (evt) => {
    const sid = evt.properties.sessionID
    if (evt.properties.status.type === "busy") {
      sync.set(
        "agent_summary",
        produce((draft: Record<string, { text: string; ai: boolean }>) => {
          delete draft[sid]
        }),
      )
      const current: AgentEntry[] = kv.get("agents", [])
      const idx = current.findIndex((a) => a.sessionID === sid)
      if (idx === -1 || !current[idx].summary) return
      kv.set(
        "agents",
        current.map((a, i) => (i === idx ? { ...a, summary: undefined } : a)),
      )
      return
    }
    if (evt.properties.status.type === "idle") {
      const current: AgentEntry[] = kv.get("agents", [])
      if (!current.some((a) => a.sessionID === sid)) return
      if (fetching.has(sid)) return
      fetching.add(sid)
      sdk.fetch(`${sdk.url}/session/${sid}/last-response`)
        .then((res) => res?.ok ? res.json() : null)
        .then((data: { text?: string; summary?: boolean } | null) => {
          if (!data || !data.text) return
          const summary = { text: data.text, ai: !!data.summary }
          sync.set("agent_summary", sid, summary)
          const latest: AgentEntry[] = kv.get("agents", [])
          kv.set(
            "agents",
            latest.map((a) => (a.sessionID === sid ? { ...a, summary } : a)),
          )
        })
        .catch(() => {})
        .finally(() => fetching.delete(sid))
    }
  })

  return <></>
}
