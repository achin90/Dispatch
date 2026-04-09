/**
 * Maps opencode session IDs to Claude Agent SDK session UUIDs.
 *
 * The Claude SDK uses UUIDs for its internal session persistence (JSONL files on disk).
 * Opencode uses its own session ID format. This module maintains a persistent mapping
 * so that the SDK can resume sessions with full conversation history.
 *
 * The mapping is stored in `~/.local/state/opencode/sdk-sessions.json`.
 */

import { Global } from "@/global"
import fs from "fs/promises"
import path from "path"

const filePath = () => path.join(Global.Path.state, "sdk-sessions.json")

let cache: Record<string, string> | undefined

async function load(): Promise<Record<string, string>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), "utf-8")
    const data = JSON.parse(raw)
    cache = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, string> : {}
  } catch {
    cache = {}
  }
  return cache!
}

async function save(map: Record<string, string>) {
  cache = map
  const dir = path.dirname(filePath())
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath(), JSON.stringify(map, null, 2))
}

export async function getSdkSessionID(sessionID: string): Promise<string | undefined> {
  const map = await load()
  return map[sessionID]
}

export async function setSdkSessionID(sessionID: string, sdkSessionID: string): Promise<void> {
  const map = await load()
  map[sessionID] = sdkSessionID
  await save(map)
}

export async function removeSdkSessionID(sessionID: string): Promise<void> {
  const map = await load()
  delete map[sessionID]
  await save(map)
}
