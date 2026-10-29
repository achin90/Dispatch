export * as SdkUsage from "./usage.js"

import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { SdkBin } from "./bin.js"
import { SdkEnv } from "./env.js"

const TIMEOUT = 30_000

type Limits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>
type Window = NonNullable<SDKControlGetUsageResponse["behaviors"]>["day"]

/**
 * The CLI's `/usage` data: claude.ai plan limits plus what contributed to them, from a scan of
 * local transcripts. Plan limits are account-wide, so this needs no Session.
 *
 * Spawns a `claude` process whose input never sends a message, so no model request is made, and
 * asks it over the control channel. The SDK method is experimental; keep its use to this file.
 */
export const read = (apiKey: string | undefined) =>
  Effect.tryPromise({
    try: async (signal) => {
      const abortController = new AbortController()
      signal.addEventListener("abort", () => abortController.abort(), { once: true })
      const bin = await SdkBin.resolveClaudeBin()
      const session = query({
        prompt: idle(abortController.signal),
        options: {
          env: SdkEnv.build({ apiKey }),
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          abortController,
          ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
        },
      })
      return session
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        .finally(() => abortController.abort())
    },
    catch: (cause) => cause,
  }).pipe(Effect.timeout(TIMEOUT), Effect.map(normalize))

/** An input stream that stays open without sending anything until the query is aborted. */
async function* idle(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
}

export function normalize(response: SDKControlGetUsageResponse) {
  const limits = response.rate_limits
  return {
    available: response.rate_limits_available && limits !== null,
    plan: response.subscription_type,
    limits: limits ? bars(limits) : [],
    extra: limits?.extra_usage?.is_enabled
      ? {
          // Credits are minor currency units. The raw response also carries an undocumented `decimal_places`
          // (2 for USD), so this assumes two.
          used: limits.extra_usage.used_credits === null ? null : limits.extra_usage.used_credits / 100,
          limit: limits.extra_usage.monthly_limit ? limits.extra_usage.monthly_limit / 100 : null,
          currency: limits.extra_usage.currency ?? null,
        }
      : null,
    behaviors: response.behaviors
      ? { day: window(response.behaviors.day), week: window(response.behaviors.week) }
      : null,
  }
}

/** The bars in the order the CLI shows them; windows the account does not have are left out. */
function bars(limits: Limits) {
  const fixed = [
    { label: "Current session", value: limits.five_hour },
    { label: "Current week (all models)", value: limits.seven_day },
    { label: "Current week (Opus)", value: limits.seven_day_opus },
    { label: "Current week (Sonnet)", value: limits.seven_day_sonnet },
  ].flatMap((item) =>
    item.value ? [{ label: item.label, percent: item.value.utilization, resetsAt: item.value.resets_at }] : [],
  )
  const scoped = (limits.model_scoped ?? []).map((item) => ({
    label: `Current week (${item.display_name})`,
    percent: item.utilization,
    resetsAt: item.resets_at,
  }))
  return [...fixed, ...scoped]
}

function window(value: Window) {
  const share = (items: ReadonlyArray<{ name: string; pct: number }>) =>
    items.map((item) => ({ name: item.name, percent: item.pct }))
  return {
    requests: value.request_count,
    sessions: value.session_count,
    behaviors: value.behaviors.map((item) => ({ key: item.key, percent: item.pct })),
    skills: share(value.skills),
    agents: share(value.agents),
    plugins: share(value.plugins),
    mcpServers: share(value.mcp_servers),
  }
}
