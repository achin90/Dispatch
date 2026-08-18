import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { BARE_COMMANDS, VOICE_COMMANDS } from "./commands"

/**
 * Reference list of the phrases Jarvis handles itself. Anything not listed here
 * is dictated into the open session instead, so this doubles as the boundary
 * between "Jarvis acts on it" and "the agent hears it".
 */
function View(props: { api: TuiPluginApi }) {
  const options: DialogSelectOption<string>[] = [...VOICE_COMMANDS, ...BARE_COMMANDS].map((item) => ({
    title: item.phrase,
    value: item.phrase,
    category: item.category,
    description: item.description,
  }))

  return (
    <DialogSelect
      title="Voice commands"
      options={options}
      onSelect={() => {
        props.api.ui.dialog.clear()
      }}
    />
  )
}

export function showVoiceHelp(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}
