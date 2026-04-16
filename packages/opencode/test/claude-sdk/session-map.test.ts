import { afterEach, describe, expect, test } from "bun:test"
import { getSdkSessionID, setSdkSessionID, removeSdkSessionID } from "../../src/session/claude-sdk-session-map"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"

// ---------------------------------------------------------------------------
// Claude SDK session map — Dispatch regression guard
//
// Maps opencode session IDs to SDK session UUIDs so that the SDK can
// resume sessions with full conversation history. Must persist to disk.
// ---------------------------------------------------------------------------

// Reset the module-level cache between tests by re-importing
// We access the file path via the same logic as the module
const filePath = () => path.join(Global.Path.state, "sdk-sessions.json")

afterEach(async () => {
  // Clean up persisted file and reset cache by removing the file
  try {
    const fp = filePath()
    await Bun.write(fp, "{}")
  } catch {}
  // The module caches in-memory, so we must go through the API to reset
  // We'll rely on setSdkSessionID to update the cache
})

describe("claude-sdk session map", () => {
  test("setSdkSessionID persists and getSdkSessionID retrieves", async () => {
    await setSdkSessionID("session-abc", "uuid-123")
    const result = await getSdkSessionID("session-abc")
    expect(result).toBe("uuid-123")
  })

  test("getSdkSessionID returns undefined for unknown session", async () => {
    const result = await getSdkSessionID("nonexistent-session-" + Date.now())
    expect(result).toBeUndefined()
  })

  test("removeSdkSessionID deletes the mapping", async () => {
    const key = "session-remove-" + Date.now()
    await setSdkSessionID(key, "uuid-456")
    expect(await getSdkSessionID(key)).toBe("uuid-456")

    await removeSdkSessionID(key)
    expect(await getSdkSessionID(key)).toBeUndefined()
  })

  test("multiple sessions can coexist", async () => {
    const a = "session-a-" + Date.now()
    const b = "session-b-" + Date.now()
    await setSdkSessionID(a, "uuid-a")
    await setSdkSessionID(b, "uuid-b")

    expect(await getSdkSessionID(a)).toBe("uuid-a")
    expect(await getSdkSessionID(b)).toBe("uuid-b")
  })

  test("setSdkSessionID overwrites existing mapping", async () => {
    const key = "session-overwrite-" + Date.now()
    await setSdkSessionID(key, "old-uuid")
    await setSdkSessionID(key, "new-uuid")

    expect(await getSdkSessionID(key)).toBe("new-uuid")
  })

  test("persists to disk", async () => {
    const key = "session-persist-" + Date.now()
    await setSdkSessionID(key, "uuid-disk")

    const data = await Filesystem.readJson(filePath())
    expect((data as Record<string, string>)[key]).toBe("uuid-disk")
  })
})
