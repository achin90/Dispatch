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
import { Filesystem } from "@/util/filesystem"
import path from "path"

const filePath = () => path.join(Global.Path.state, "sdk-sessions.json")

let cache: Record<string, string> | undefined

async function load(): Promise<Record<string, string>> {
  if (cache) return cache
  try {
    const data = await Filesystem.readJson(filePath())
    cache = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, string> : {}
  } catch {
    cache = {}
  }
  return cache!
}

async function save(map: Record<string, string>) {
  cache = map
  await Filesystem.writeJson(filePath(), map)
}

/**
 * Get the SDK session UUID for an opencode session ID, if one exists.
 */
export async function getSdkSessionID(sessionID: string): Promise<string | undefined> {
  const map = await load()
  return map[sessionID]
}

/**
 * Set the SDK session UUID for an opencode session ID.
 * Called after the first query() returns a system message with session_id.
 */
export async function setSdkSessionID(sessionID: string, sdkSessionID: string): Promise<void> {
  const map = await load()
  map[sessionID] = sdkSessionID
  await save(map)
}

/**
 * Remove the SDK session UUID mapping for an opencode session ID.
 */
export async function removeSdkSessionID(sessionID: string): Promise<void> {
  const map = await load()
  delete map[sessionID]
  await save(map)
}
