import { createMemo, createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { DialogContext } from "../../ui/dialog"
import { useClient } from "../../context/client"

/** Directories under `root`, as relative paths; "." is the root itself. Hidden directories are left out. */
export function DialogDirectorySelect(props: { title: string; root: string; onSelect: (directory: string) => void }) {
  const client = useClient()
  const [query, setQuery] = createSignal("")
  const [directories] = createResource(
    () => ({ query: query(), root: props.root }),
    (input) =>
      (input.query
        ? client.api.file.find({ query: input.query, type: "directory", limit: 50, location: { directory: input.root } })
        : client.api.file.list({ location: { directory: input.root } })
      )
        .then((result) => result.data.flatMap((entry) => (entry.type === "directory" ? [entry.path] : [])))
        .catch(() => []),
    { initialValue: [] },
  )
  const options = createMemo<DialogSelectOption<string>[]>(() => [
    { value: ".", title: ".", description: "current directory" },
    ...(directories() ?? [])
      .map((directory) => directory.replace(/\/+$/, ""))
      .filter((directory) => directory && directory !== "." && !directory.split("/").some((part) => part.startsWith(".")))
      .map((directory) => ({ value: directory, title: directory })),
  ])
  return (
    <DialogSelect
      title={props.title}
      placeholder="Filter directories"
      options={options()}
      skipFilter
      onFilter={setQuery}
      onSelect={(option) => props.onSelect(option.value)}
    />
  )
}

DialogDirectorySelect.show = (dialog: DialogContext, title: string, root: string) =>
  new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => <DialogDirectorySelect title={title} root={root} onSelect={resolve} />,
      () => resolve(undefined),
    )
  })
