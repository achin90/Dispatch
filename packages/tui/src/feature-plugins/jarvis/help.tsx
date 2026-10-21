import type { Plugin } from "@opencode/plugin/tui"
import { BARE_COMMANDS, VOICE_COMMANDS } from "./commands"

/**
 * Reference list of the phrases Jarvis handles itself. Anything not listed here
 * is dictated into the open session instead, so this doubles as the boundary
 * between "Jarvis acts on it" and "the agent hears it".
 */
export function showVoiceHelp(context: Plugin.Context) {
  void context.ui.dialog.select({
    title: "Voice commands",
    options: [...VOICE_COMMANDS, ...BARE_COMMANDS].map((item) => ({
      title: item.phrase,
      value: item.phrase,
      category: item.category,
      description: item.description,
    })),
  })
}
