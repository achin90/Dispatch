export * as BridgeQuestion from "./question.js"

import type { Form } from "@opencode/schema/form"
import type { SdkAdapter } from "../sdk/adapter.js"

/**
 * One question of a request as plain text for the remote transcript. claude.ai does not render
 * opencode's question form, so the remote copy is an ordinary assistant message and the answer
 * comes back as an ordinary typed reply. Options are numbered so a reply can name one.
 */
export function render(prompts: ReadonlyArray<SdkAdapter.Question>, at: number) {
  const prompt = prompts[at]
  const heading = prompts.length > 1 ? `**${prompt.header}** (${at + 1}/${prompts.length})` : `**${prompt.header}**`
  return [
    heading,
    prompt.question,
    "",
    ...prompt.options.map(
      (option, index) => `${index + 1}. **${option.label}**${option.description ? ` — ${option.description}` : ""}`,
    ),
    "",
    prompt.multiple
      ? "_Reply with option numbers or labels separated by commas, or type your own answer._"
      : "_Reply with the option number, its exact label, or type your own answer._",
  ].join("\n")
}

/**
 * The answer `text` gives to `prompt`: an exact option label (case-insensitive), else a 1-based
 * option number, else the text itself (Dispatch question fields always accept a typed answer).
 * Multi-select replies are split on commas. Blank text answers nothing.
 */
export function match(prompt: SdkAdapter.Question, text: string): Form.Value | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  if (!prompt.multiple) return pick(prompt, trimmed)
  return trimmed
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "")
    .map((piece) => pick(prompt, piece))
}

function pick(prompt: SdkAdapter.Question, text: string) {
  const labelled = prompt.options.find((option) => option.label.trim().toLowerCase() === text.toLowerCase())
  if (labelled) return labelled.label
  const index = Number(text)
  if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) return prompt.options[index - 1].label
  return text
}

/**
 * Interprets replies typed on claude.ai. A reply is one line but the form is answered at once, so a
 * multi-question request is filled in order: each accepted reply answers the current question and
 * `ask` writes the next one. The last answer calls `reply` with the whole form answer, keyed like
 * the runner's question form (`q0`, `q1`, ...). Returns whether the text was consumed.
 */
export function answerer(
  prompts: ReadonlyArray<SdkAdapter.Question>,
  handlers: { readonly ask: (at: number) => void; readonly reply: (answer: Form.Answer) => void },
) {
  const collected: Record<string, Form.Value> = {}
  let at = 0
  return (text: string) => {
    const prompt = prompts[at]
    if (!prompt) return false
    const answer = match(prompt, text)
    if (answer === undefined) return false
    collected[`q${at}`] = answer
    at++
    if (at < prompts.length) handlers.ask(at)
    if (at === prompts.length) handlers.reply({ ...collected })
    return true
  }
}
