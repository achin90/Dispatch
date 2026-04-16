import type { Event } from "@opencode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // Special hack for truly global events
      if (event.directory === "global") {
        handler(event.payload)
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) {
          handler(event.payload)
        }

        return
      }

      // Accept events from the current project directory AND from any
      // other directory (e.g. agent sessions running in worktrees).
      // Without this, real-time updates from agent sessions are invisible
      // to the TUI because those sessions publish events under their
      // worktree directory, not the main project directory.
      handler(event.payload)
    })
  }

  function on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void) {
    return subscribe((event) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>)
    })
  }

  return {
    subscribe,
    on,
  }
}
