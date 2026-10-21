export * as SdkSessionMap from "./session-map.js"

import { Session } from "@opencode/core/session"
import { SessionSchema } from "@opencode/core/session/schema"
import { Effect } from "effect"

/**
 * The Claude Agent SDK conversation a Session resumes, stored in `Session.metadata`.
 *
 * Children and forks inherit their parent's metadata, so an entry also records the Session that
 * owns it and is ignored anywhere else. `cwd` is the directory the conversation started in: the
 * SDK stores transcripts per project directory and only finds them again from that directory.
 */
export const KEY = "dispatch.sdk"

export interface Entry {
  readonly uuid: string
  readonly cwd: string
}

export function read(session: Pick<SessionSchema.Info, "id" | "metadata">): Entry | undefined {
  const value = session.metadata?.[KEY]
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (entry.sessionID !== session.id) return undefined
  if (typeof entry.uuid !== "string" || typeof entry.cwd !== "string") return undefined
  return { uuid: entry.uuid, cwd: entry.cwd }
}

/** Metadata writes replace the whole record, so read the latest copy first. */
export const write = Effect.fn("SdkSessionMap.write")(function* (sessionID: SessionSchema.ID, entry: Entry) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const current = read(session)
  if (current?.uuid === entry.uuid && current.cwd === entry.cwd) return
  yield* sessions.setMetadata({
    sessionID,
    metadata: { ...session.metadata, [KEY]: { sessionID, uuid: entry.uuid, cwd: entry.cwd } },
  })
})

export const remove = Effect.fn("SdkSessionMap.remove")(function* (sessionID: SessionSchema.ID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  if (!session.metadata || !(KEY in session.metadata)) return
  const { [KEY]: _, ...rest } = session.metadata
  yield* sessions.setMetadata({ sessionID, metadata: rest })
})
