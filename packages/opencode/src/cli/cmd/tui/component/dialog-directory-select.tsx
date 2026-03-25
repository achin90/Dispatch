import { createResource, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"

export function DialogDirectorySelect(props: {
  title: string
  onSelect?: (value: string) => void
  onCancel?: () => void
}) {
  const sdk = useSDK()

  const [store, setStore] = createStore({
    filter: "",
  })

  const [directories] = createResource(
    () => [store.filter],
    async () => {
      const result = await sdk.client.find.files({
        query: store.filter,
        type: "directory",
      })
      if (result.error) return []
      return result.data ?? []
    },
    { initialValue: [] },
  )

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const dirs = directories() ?? []
    const dotOption: DialogSelectOption<string> = {
      value: ".",
      title: ".",
      description: "current directory",
    }
    const dirOptions: DialogSelectOption<string>[] = dirs
      .filter((d) => d !== ".")
      .map((dir) => ({
        value: dir,
        title: dir,
      }))
    return [dotOption, ...dirOptions]
  })

  return (
    <DialogSelect
      title={props.title}
      options={options()}
      skipFilter
      onFilter={(query) => setStore("filter", query)}
      onSelect={(option) => {
        props.onSelect?.(option.value)
      }}
    />
  )
}

DialogDirectorySelect.show = (dialog: DialogContext, title: string) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogDirectorySelect
          title={title}
          onSelect={(value) => resolve(value)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
