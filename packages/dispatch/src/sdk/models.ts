export * as SdkModels from "./models.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

/** AI SDK package name the Dispatch plugin answers with an in-process Claude Agent SDK language model. */
export const PACKAGE = "aisdk:@opencode/dispatch/claude-agent-sdk"

export const providerID = Provider.ID.anthropic

export interface Definition {
  /** Model id the Claude Code CLI accepts. */
  readonly resolves: string
  readonly name: string
  readonly context: number
  readonly output: number
  readonly description: string
  readonly reasoning: boolean
  /** Catalog model whose list prices the alias reports. */
  readonly catalog?: string
}

/**
 * Static Claude Agent SDK models, keyed by the alias opencode stores on sessions.
 *
 * Every Opus entry that claims a 1M window carries the `[1m]` suffix: the suffix is the
 * opt-in, and a bare id makes the CLI report a 200k window and auto-compact early.
 * Sonnet 5 is native 1M and rejects the suffix.
 */
export const definitions: Readonly<Record<string, Definition>> = {
  default: {
    resolves: "claude-opus-5-5[1m]",
    name: "Opus 5.5",
    context: 1_000_000,
    output: 64_000,
    description: "Most capable for complex work",
    reasoning: true,
    catalog: "claude-opus-5-5",
  },
  "fable-5-1": {
    resolves: "claude-fable-5-1",
    name: "Fable 5.1",
    context: 1_000_000,
    output: 64_000,
    description: "Most intelligent, for the hardest problems · $10/$50 per Mtok",
    reasoning: true,
    catalog: "claude-fable-5-1",
  },
  "opus-5-5": {
    resolves: "claude-opus-5-5[1m]",
    name: "Opus 5.5",
    context: 1_000_000,
    output: 64_000,
    description: "Most capable for complex work",
    reasoning: true,
    catalog: "claude-opus-5-5",
  },
  "opus-4-6[1m]": {
    resolves: "claude-opus-4-6[1m]",
    name: "Opus 4.6 (1M context)",
    context: 1_000_000,
    output: 64_000,
    description: "Previous generation Opus · 1M context",
    reasoning: true,
    catalog: "claude-opus-4-6",
  },
  sonnet: {
    resolves: "claude-sonnet-5",
    name: "Sonnet 5",
    context: 1_000_000,
    output: 64_000,
    description: "Best for everyday tasks",
    reasoning: true,
    catalog: "claude-sonnet-5",
  },
  haiku: {
    resolves: "claude-haiku-4-5-20251001",
    name: "Haiku 4.5",
    context: 200_000,
    output: 8_192,
    description: "Fastest for quick answers",
    reasoning: false,
    catalog: "claude-haiku-4-5-20251001",
  },
}

export const DEFAULT = "opus-5-5"

// Models whose thinking is summarized take the full effort ladder; matched against a dash-normalized id.
const SUMMARIZED_THINKING = ["fable-5", "opus-5", "opus-4-8", "opus-4-7", "sonnet-5"]

/** Effort levels the CLI accepts for a model; each becomes a model variant whose id is the effort. */
export function efforts(resolves: string, reasoning: boolean): readonly string[] {
  if (!reasoning) return []
  const id = resolves.replaceAll(".", "-")
  if (SUMMARIZED_THINKING.some((value) => id.includes(value))) return ["low", "medium", "high", "xhigh", "max"]
  if (["opus-4-6", "sonnet-4-6"].some((value) => id.includes(value))) return ["low", "medium", "high", "max"]
  return []
}

/** The Model.Info for one alias. `cost` comes from the matching catalog entry when the caller has one. */
export function info(alias: string, definition: Definition, cost: Model.Info["cost"] = []): Model.Info {
  return {
    id: Model.ID.make(alias),
    modelID: Model.ID.make(definition.resolves),
    providerID,
    family: Model.Family.make(definition.resolves.split("-").slice(0, 2).join("-")),
    name: definition.name,
    package: PACKAGE,
    // Model.Info has no description field; keep v1's sdkDescription so a picker can show it.
    settings: { sdkDescription: definition.description },
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"], temperature: true },
    variants: efforts(definition.resolves, definition.reasoning).map((effort) => ({
      id: Model.VariantID.make(effort),
    })),
    time: { released: 0 },
    cost,
    // "default" resolves to the same model as opus-5-5; deprecated hides it from the picker while
    // exact references such as anthropic/default keep resolving.
    status: alias === "default" ? "deprecated" : "active",
    enabled: true,
    limit: { context: definition.context, output: definition.output },
  }
}

/** Whether a resolved session model runs through the Claude Agent SDK runner. */
export const isSdkModel = (ref: { readonly providerID: string }) => ref.providerID === providerID

/** The id the CLI accepts for a catalog model id (alias or full id). */
export const cliModel = (modelID: string) => definitions[modelID]?.resolves ?? modelID

/** Normalize a wire model id to the catalog style, e.g. "claude-haiku-4-5-20251001" → "haiku-4-5". */
export const normalizeWireModel = (model: string | undefined) => model?.replace(/^claude-/, "").replace(/-\d{8}$/, "")
