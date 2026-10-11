import { createResource } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

const options = [
  { value: "off", title: "Off", description: "No advisor" },
  { value: "fable", title: "Fable", description: "Strongest reviewer" },
  { value: "opus", title: "Opus", description: "Only advises models at or below Opus" },
  { value: "sonnet", title: "Sonnet", description: "Only advises models at or below Sonnet" },
]

export function DialogAdvisor() {
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  // Saving the advisor doesn't restart instances, so the synced config copy
  // goes stale; read the live value from the global config instead.
  const [current] = createResource(() =>
    sdk.client.global.config
      .get()
      .then((x) => x.data?.advisor ?? "off")
      .catch(() => "off"),
  )

  return (
    <DialogSelect<string>
      title="Select advisor model"
      flat={true}
      current={current()}
      options={options.map((option) => ({
        ...option,
        onSelect: async () => {
          dialog.clear()
          if (current() === option.value) return
          await sdk.client.global.config
            .update({ config: { advisor: option.value } }, { throwOnError: true })
            .then(() =>
              toast.show({
                message: option.value === "off" ? "Advisor turned off" : `Advisor set to ${option.title}`,
                variant: "success",
              }),
            )
            .catch((error) =>
              toast.show({
                message: error instanceof Error ? error.message : "Failed to update advisor",
                variant: "error",
              }),
            )
        },
      }))}
    />
  )
}
