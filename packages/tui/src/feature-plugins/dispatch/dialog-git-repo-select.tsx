import path from "path"
import { createMemo, createResource } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { DialogContext } from "../../ui/dialog"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { usePathFormatter } from "../../context/path-format"
import { DispatchRpc } from "./rpc"

/**
 * Picks the repository a worktree agent branches from. Repositories come from the Dispatch
 * `gitRepos.list` scan under `root`; known projects are always offered too, so the picker still
 * works against a server without the Dispatch RPC.
 */
export function DialogGitRepoSelect(props: { title: string; root: string; onSelect: (directory: string) => void }) {
  const client = useClient()
  const data = useData()
  const paths = usePathFormatter()
  const [repos] = createResource(
    () => props.root,
    (root) => DispatchRpc.optional(client.api, "gitRepos.list", { root }, root).then((result) => result?.repos ?? []),
    { initialValue: [] },
  )
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const scanned = repos() ?? []
    const projects = data.project
      .list()
      .flatMap((project) => (project.vcs && !scanned.includes(project.canonical) ? [project.canonical] : []))
    return [...scanned, ...projects].map((directory) => ({
      value: directory,
      title: path.basename(directory),
      description: paths.format(directory),
    }))
  })
  return (
    <DialogSelect
      title={props.title}
      placeholder="Filter repositories"
      description="Choose the repository to create a new worktree from"
      options={options()}
      emptyView={<text>{repos.loading ? "Scanning for repositories…" : "No git repositories found"}</text>}
      onSelect={(option) => props.onSelect(option.value)}
    />
  )
}

DialogGitRepoSelect.show = (dialog: DialogContext, title: string, root: string) =>
  new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => <DialogGitRepoSelect title={title} root={root} onSelect={resolve} />,
      () => resolve(undefined),
    )
  })
