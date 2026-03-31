import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"
import { Log } from "@/util/log"

const log = Log.create({ service: "tui-route" })

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
  workspaceID?: string
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type DiffviewRoute = {
  type: "diffview"
  directory: string
}

export type Route = HomeRoute | SessionRoute | DiffviewRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(
      process.env["OPENCODE_ROUTE"]
        ? JSON.parse(process.env["OPENCODE_ROUTE"])
        : {
            type: "home",
          },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        log.info("navigate", {
          type: route.type,
          sessionID: "sessionID" in route ? route.sessionID : undefined,
          directory: "directory" in route ? route.directory : undefined,
        })
        console.log("navigate", route)
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
