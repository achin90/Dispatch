import { createResource } from "solid-js"
import { DialogSelect } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { useClient } from "../../context/client"
import { errorMessage } from "../../util/error"
import { DispatchRpc } from "./rpc"

const options = [
  { value: "off", title: "Off", description: "No advisor" },
  { value: "fable", title: "Fable", description: "Strongest reviewer" },
  { value: "opus", title: "Opus", description: "Only advises models at or below Opus" },
  { value: "sonnet", title: "Sonnet", description: "Only advises models at or below Sonnet" },
]

/**
 * The Claude Agent SDK advisor model, the global `advisor` config key. The runner reads it on every
 * turn, so a change applies to the next turn without reloading any location.
 */
export function DialogAdvisor() {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const [current] = createResource(() => readAdvisor(client.api))

  return (
    <DialogSelect<string>
      title="Select advisor model"
      flat={true}
      current={current()}
      options={options}
      onSelect={async (option) => {
        dialog.clear()
        if (current() === option.value) return
        await DispatchRpc.call(client.api, "advisor.set", { advisor: option.value })
          .then(() =>
            toast.show({
              message: option.value === "off" ? "Advisor turned off" : `Advisor set to ${option.title}`,
              variant: "success",
            }),
          )
          .catch((error: unknown) =>
            toast.show({
              message:
                error instanceof DispatchRpc.UnavailableError
                  ? "This server cannot change the advisor"
                  : errorMessage(error),
              variant: "error",
            }),
          )
      }}
    />
  )
}

// Config entries run lowest to highest precedence, so the last document that sets the key wins.
async function readAdvisor(api: ReturnType<typeof useClient>["api"]) {
  const live = await DispatchRpc.optional(api, "advisor.get", undefined)
  if (live) return live.advisor ?? "off"
  const entries = await api.config.get().catch(() => [])
  return (
    entries.flatMap((entry) => (entry.type === "document" && entry.info.advisor ? [entry.info.advisor] : [])).at(-1) ??
    "off"
  )
}
