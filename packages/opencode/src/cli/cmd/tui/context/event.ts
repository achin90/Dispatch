import type { Event } from "@opencode-ai/sdk/v2"
import * as Log from "@opencode-ai/core/util/log"
import { useSDK } from "./sdk"

type EventMetadata = {
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // No directory/workspace filtering here on purpose: agent sessions
      // running in worktrees publish events under their own worktree
      // directory/workspace. Dropping them here would make agent session
      // updates invisible to the TUI. Consumers that genuinely care about
      // the originating workspace filter on the `workspace` metadata.
      handler(event.payload, { workspace: event.workspace })
    })
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    on,
  }
}
