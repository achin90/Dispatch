import { createResource, createMemo } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import path from "path"

export function DialogGitRepoSelect(props: {
  title: string
  description?: string
  defaultRoot: string
  onSelect?: (value: string) => void
  onCancel?: () => void
}) {
  const sdk = useSDK()

  const [repos] = createResource(
    async () => {
      const result = await sdk.client.gitRepos.list({ root: props.defaultRoot })
      if (result.error) return []
      return result.data ?? []
    },
    { initialValue: [] },
  )

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const items = repos() ?? []
    return items.map((repoPath: string) => ({
      value: repoPath,
      title: path.basename(repoPath),
      description: repoPath,
    }))
  })

  return (
    <DialogSelect
      title={props.title}
      description={props.description}
      placeholder="Filter repositories"
      options={options()}
      onSelect={(option) => {
        props.onSelect?.(option.value)
      }}
    />
  )
}

DialogGitRepoSelect.show = (
  dialog: DialogContext,
  title: string,
  defaultRoot: string,
  description?: string,
) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogGitRepoSelect
          title={title}
          description={description}
          defaultRoot={defaultRoot}
          onSelect={(value) => resolve(value)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
