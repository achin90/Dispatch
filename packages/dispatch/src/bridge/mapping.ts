export * as BridgeMapping from "./mapping.js"

import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { Effect } from "effect"

/**
 * The claude.ai code session (`cse_*`) a Session mirrors to, stored in `Session.metadata` so it
 * survives restarts and keeps one remote conversation across turns.
 *
 * Children and forks inherit their parent's metadata, so an entry records the Session that owns
 * it and is ignored anywhere else. `mark` is the newest message already in the remote transcript.
 */
export const KEY = "dispatch.bridge"

export interface Entry {
  readonly codeSessionID: string
  readonly mark?: SessionMessage.ID
}

export function read(session: Pick<SessionSchema.Info, "id" | "metadata">): Entry | undefined {
  const value = session.metadata?.[KEY]
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (entry.sessionID !== session.id || typeof entry.codeSessionID !== "string") return undefined
  return {
    codeSessionID: entry.codeSessionID,
    ...(typeof entry.mark === "string" ? { mark: SessionMessage.ID.make(entry.mark) } : {}),
  }
}

/**
 * Writes or (with `undefined`) removes the entry. Metadata writes replace the whole record, so
 * this reads the latest copy first; callers serialize writes for one Session.
 */
export const write = Effect.fn("BridgeMapping.write")(function* (
  sessionID: SessionSchema.ID,
  entry: Entry | undefined,
) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const current = read(session)
  if (!entry) {
    if (!session.metadata || !(KEY in session.metadata)) return
    const { [KEY]: _, ...rest } = session.metadata
    return yield* sessions.setMetadata({ sessionID, metadata: rest })
  }
  if (current?.codeSessionID === entry.codeSessionID && current.mark === entry.mark) return
  yield* sessions.setMetadata({
    sessionID,
    metadata: {
      ...session.metadata,
      [KEY]: { sessionID, codeSessionID: entry.codeSessionID, ...(entry.mark ? { mark: entry.mark } : {}) },
    },
  })
})
