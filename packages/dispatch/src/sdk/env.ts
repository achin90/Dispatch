export * as SdkEnv from "./env.js"

// Variables that make a spawned Claude Code CLI believe it is nested inside another Claude Code
// session (or another agent harness), which changes binary resolution and behaviour.
const NESTED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/

/** Environment for the spawned CLI. `query()` replaces the subprocess environment, so it starts from `base`. */
export function build(input: { readonly apiKey?: string; readonly base?: Record<string, string | undefined> } = {}) {
  const base = input.base ?? process.env
  return {
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !NESTED.test(name))),
    // The CLI only enables native 1M windows when it believes it talks to first-party Anthropic;
    // a local proxy in ANTHROPIC_BASE_URL fails that gate and the window falls back to 200k.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    // The optimistic tool-search mode returns empty results that models read as dead MCP servers.
    ENABLE_TOOL_SEARCH: "false",
    ...(input.apiKey ? { ANTHROPIC_API_KEY: input.apiKey } : {}),
  }
}
