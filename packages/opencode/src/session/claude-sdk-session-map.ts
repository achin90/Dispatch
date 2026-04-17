/**
 * Maps opencode session IDs to Claude Agent SDK session UUIDs.
 *
 * The Claude SDK uses UUIDs for its internal session persistence (JSONL files on disk).
 * Opencode uses its own session ID format. This module maintains a persistent mapping
 * so that the SDK can resume sessions with full conversation history.
 *
 * Each entry stores both the UUID and the `cwd` that was active when the SDK session
 * was created. On resume we must pass the original `cwd` so the SDK can find its
 * session files, even if the opencode session has since been moved to a different
 * directory (e.g. when an agent switches worktrees).
 *
 * The mapping is stored in `~/.local/state/opencode/sdk-sessions.json`.
 */

import { Global } from "@/global"
import { Filesystem } from "@/util"
import path from "path"

export interface SdkSessionEntry {
  uuid: string
  cwd: string
}

const filePath = () => path.join(Global.Path.state, "sdk-sessions.json")

let cache: Record<string, string | SdkSessionEntry> | undefined

async function load(): Promise<Record<string, string | SdkSessionEntry>> {
  if (cache) return cache
  try {
    const data = await Filesystem.readJson(filePath())
    cache = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, string | SdkSessionEntry> : {}
  } catch {
    cache = {}
  }
  return cache!
}

async function save(map: Record<string, string | SdkSessionEntry>) {
  cache = map
  await Filesystem.writeJson(filePath(), map)
}

function toEntry(value: string | SdkSessionEntry): SdkSessionEntry | undefined {
  if (!value) return undefined
  // Backwards-compat: old entries are plain UUID strings without a cwd.
  if (typeof value === "string") return { uuid: value, cwd: "" }
  return value
}

/**
 * Get the SDK session entry for an opencode session ID, if one exists.
 */
export async function getSdkSessionEntry(sessionID: string): Promise<SdkSessionEntry | undefined> {
  const map = await load()
  return toEntry(map[sessionID])
}

/** Convenience: return just the UUID (backwards-compat shim). */
export async function getSdkSessionID(sessionID: string): Promise<string | undefined> {
  return (await getSdkSessionEntry(sessionID))?.uuid
}

/**
 * Set the SDK session entry for an opencode session ID.
 * Called after the first query() returns a system message with session_id.
 */
export async function setSdkSessionID(sessionID: string, sdkSessionID: string, cwd: string): Promise<void> {
  const map = await load()
  map[sessionID] = { uuid: sdkSessionID, cwd }
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
