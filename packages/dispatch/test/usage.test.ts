import { describe, expect, test } from "bun:test"
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk"
import { SdkUsage } from "../src/sdk/usage"

const window = {
  request_count: 10,
  session_count: 2,
  behaviors: [{ key: "long_context" as const, pct: 100, count: 10 }],
  agents: [],
  skills: [{ name: "stack-add", pct: 2 }],
  plugins: [],
  mcp_servers: [{ name: "bigquery", pct: 3 }],
}

const response: SDKControlGetUsageResponse = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37, resets_at: "2026-10-29T21:20:00Z" },
    seven_day: { utilization: 4, resets_at: "2026-11-05T14:00:00Z" },
    seven_day_opus: null,
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-05T14:00:00Z" }],
    extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 4322, utilization: null, currency: "USD" },
  },
  behaviors: { day: window, week: window },
}

describe("SdkUsage.normalize", () => {
  test("orders the plan bars like the CLI and skips windows the account lacks", () => {
    const usage = SdkUsage.normalize(response)
    expect(usage.available).toBe(true)
    expect(usage.limits).toEqual([
      { label: "Current session", percent: 37, resetsAt: "2026-10-29T21:20:00Z" },
      { label: "Current week (all models)", percent: 4, resetsAt: "2026-11-05T14:00:00Z" },
      { label: "Current week (Fable)", percent: 0, resetsAt: "2026-11-05T14:00:00Z" },
    ])
  })

  test("converts extra usage credits from cents and treats a zero limit as none", () => {
    expect(SdkUsage.normalize(response).extra).toEqual({ used: 43.22, limit: null, currency: "USD" })
  })

  test("keeps the contribution breakdown", () => {
    expect(SdkUsage.normalize(response).behaviors?.day).toEqual({
      requests: 10,
      sessions: 2,
      behaviors: [{ key: "long_context", percent: 100 }],
      skills: [{ name: "stack-add", percent: 2 }],
      agents: [],
      plugins: [],
      mcpServers: [{ name: "bigquery", percent: 3 }],
    })
  })

  test("reports no plan limits for an API key login", () => {
    const usage = SdkUsage.normalize({ ...response, rate_limits_available: false, rate_limits: null, behaviors: null })
    expect(usage).toMatchObject({ available: false, limits: [], extra: null, behaviors: null })
  })
})
