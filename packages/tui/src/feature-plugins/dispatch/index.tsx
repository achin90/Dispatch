import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { useArgs } from "../../context/args"
import { useData } from "../../context/data"
import { Dashboard, ROUTE } from "./dashboard"
import { DispatchModel } from "./model"
import { dispatchState } from "./state"
import { DispatchWatcher } from "./watch"

/** Prompt footer additions: the `◉ remote` mirror indicator and the way back to the dashboard. */
function PromptFooter(props: { context: Plugin.Context; sessionID?: string; showDetails: boolean }) {
  const args = useArgs()
  const data = useData()
  const store = dispatchState(props.context)
  const theme = () => props.context.theme
  const remote = () => {
    const sessionID = props.sessionID
    return sessionID !== undefined && store.state.remote.includes(data.session.root(sessionID))
  }
  const shortcut = () => props.context.keymap.shortcuts("session.dashboard")[0]
  return (
    <box flexDirection="row" gap={2} flexShrink={0}>
      <Show when={remote()}>
        <text fg={theme().text.feedback.success.base} wrapMode="none">
          ◉ remote
        </text>
      </Show>
      <Show when={props.showDetails && !args.noDashboard && shortcut()}>
        {(key) => (
          <text fg={theme().text.base} wrapMode="none">
            {key()} <span style={{ fg: theme().text.muted }}>dashboard</span>
          </text>
        )}
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: DispatchModel.PLUGIN_ID,
  setup(context) {
    context.ui.router.register({ name: ROUTE, render: () => <Dashboard context={context} /> })
    context.ui.slot({ append: "app", render: () => <DispatchWatcher context={context} route={ROUTE} /> })
    context.ui.slot({
      append: "prompt.footer",
      render: (input) => <PromptFooter context={context} sessionID={input.sessionID} showDetails={input.showDetails} />,
    })
  },
})
