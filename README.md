# Dispatch

A multi-agent dashboard built on top of [OpenCode](https://github.com/anomalyco/opencode), the open source AI coding agent.

> **Fork notice**: This project is a fork of [opencode](https://github.com/anomalyco/opencode) (MIT License, Copyright 2025 opencode). It is **not** built by the OpenCode team and is **not** affiliated with them. See [LICENSE](./LICENSE) for the full license text.

---

## What is Dispatch?

Dispatch replaces OpenCode's single-session TUI with a **multi-agent dashboard** and adds the **Claude Agent SDK** as a backend for routing Anthropic API requests, authenticating with your existing Claude Code subscription. The Vercel AI SDK is retained for other providers.

### Features added in this fork

**Agent Dashboard (home screen)**
- Table view showing all active agents with columns: #, Name, Status, Activity
- Agent registry backed by a KV store, decoupled from sessions
- Keyboard-driven workflow:
  - `a` -- create a new agent (spawns a new session)
  - `j`/`k` or arrow keys -- navigate rows
  - `Enter` -- open an agent's session
  - `d` -- remove agent from dashboard
  - `x` -- delete worktree and all agents in that directory
- Live status per agent: Working (with spinner), Retrying, Waiting for user, Approve (y/n)
- Inline permission approval: `y` to allow, `n` to reject pending tool-use requests directly from the dashboard
- Detail row showing tool request context (bash command, diff preview, glob patterns)
- Activity summary showing `+additions -deletions files` from the session

**Claude Agent SDK backend**
- Added `@anthropic-ai/claude-agent-sdk` for routing Anthropic API requests (Vercel AI SDK retained for other providers)
- Uses your existing Claude Code login (API key or subscription auth)
- SDK owns the tool loop and execution (Read, Write, Edit, Bash, Glob, Grep)
- App owns TUI rendering, permission UI, message persistence, and auth
- Bridge architecture documented in [`packages/opencode/AGENTS.md`](./packages/opencode/AGENTS.md)

---

## Installation

This fork is not published to npm. Clone and build from source:

```bash
git clone https://github.com/<your-org>/Dispatch.git
cd Dispatch
bun install
```

---

## Configuration

Dispatch uses the same configuration files and settings as OpenCode. For full documentation on configuring providers, MCP servers, keybindings, hooks, permissions, and more, see the **[OpenCode docs](https://opencode.ai/docs)**.

Key config locations:
- `~/.config/opencode/` -- global settings
- `.opencode/` in your project root -- project-level settings

---

## Upstream OpenCode

This project tracks upstream [opencode](https://github.com/anomalyco/opencode). For general OpenCode information:

- [OpenCode documentation](https://opencode.ai/docs)
- [OpenCode Discord](https://opencode.ai/discord)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)

---

## License

MIT License -- see [LICENSE](./LICENSE).

This project includes code from [opencode](https://github.com/anomalyco/opencode), Copyright 2025 opencode, used under the MIT License.
