# Dispatch

<!-- test comment for pr creation -->

A multi-agent dashboard built on top of [OpenCode](https://github.com/anomalyco/opencode), the open source AI coding agent.

> **Fork notice**: This project is a fork of [opencode](https://github.com/anomalyco/opencode) (MIT License, Copyright 2025 opencode). It is **not** built by the OpenCode team and is **not** affiliated with them. See [LICENSE](./LICENSE) for the full license text.

---

## What is Dispatch?

<img width="700" alt="image" src="https://github.com/user-attachments/assets/34c07a3c-ae83-4fbd-9281-f4a950c8ed4d" />

<video src="https://github.com/user-attachments/assets/4a1380fb-147b-443a-81d8-b15b21e6afd0" width="700" controls></video>

Dispatch replaces OpenCode's single-session TUI with a **multi-agent dashboard** and adds the **Claude Agent SDK** as a backend for routing Anthropic API requests, authenticating with your existing Claude Code subscription. The Vercel AI SDK is retained for other providers.

### Features added in this fork

**Agent Dashboard (home screen)**

- Table view showing all active agents with columns: #, Name, Status, Activity
- Agent registry backed by a KV store, decoupled from sessions
- Live status per agent: Working (with spinner), Retrying, Waiting for user, Approve (y/n)
- Inline permission approval: `y` to allow, `n` to reject pending tool-use requests directly from the dashboard
- Detail row showing tool request context (bash command, diff preview, glob patterns)
- Activity summary showing `+additions -deletions files` from the session

#### Dashboard Keybindings

**Navigation**

| Key | Action |
| --- | ------ |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `1`–`9` | Jump to agent #1–#9 |
| `0` | Jump to agent #10 |
| `!@#$%^&*()` | Jump to agents #11–#20 |

**Agent Management**

| Key | Action |
| --- | ------ |
| `a` | Create a new agent (prompts for directory and name) |
| `w` | Create a new worktree agent (git worktree + session) |
| `d` | Remove selected agent from the dashboard |
| `x` | Delete the worktree and all agents in that directory |

**Session Actions**

| Key | Action |
| --- | ------ |
| `Enter` | Open the selected agent's session |
| `i` | Send a message to the agent without leaving the dashboard |
| `D` | Open diff view for the agent's directory |
| `t` | Attach a terminal to the agent's directory |
| `c` | Copy the agent's directory path to the clipboard |

**Permission Approval**

| Key | Action |
| --- | ------ |
| `y` | Approve the pending tool-use request |
| `n` | Reject the pending tool-use request |

**GitHub / PR** _(visible only when GitHub is authenticated)_

| Key | Action |
| --- | ------ |
| `P` | Create a pull request for the selected worktree branch |
| `o` | Copy the PR URL to the clipboard |
| `M` | Merge the open PR for the selected worktree branch |
| `r` | Refresh diff stats and PR statuses |

**Claude Agent SDK backend**

- Added `@anthropic-ai/claude-agent-sdk` for routing Anthropic API requests (Vercel AI SDK retained for other providers)
- Uses your existing Claude Code login (API key or subscription auth)
- SDK owns the tool loop and execution (Read, Write, Edit, Bash, Glob, Grep)
- App owns TUI rendering, permission UI, message persistence, and auth
- Bridge architecture documented in [`packages/dispatch/AGENTS.md`](./packages/dispatch/AGENTS.md)
- Release binaries embed the native `claude` CLI, so no separate Claude Code install is needed

---

## Installation

### Option 1: curl (recommended)

Installs a pre-built binary for your platform to `~/.dispatch/bin/dispatch` and adds it to your PATH:

```bash
curl -fsSL https://raw.githubusercontent.com/achin90/Dispatch/claudesdk/install | bash
```

To install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/achin90/Dispatch/claudesdk/install | bash -s -- --version 0.1.0
```

Then run from any directory:

```bash
dispatch
dispatch ~/Documents/workspace
```

### Option 2: Build from source

Requires [Bun](https://bun.sh) v1.4.2 or later (the version pinned in `package.json`). Builds with `packages/cli/script/build.ts --single` and installs to `~/.dispatch/bin/dispatch`:

```bash
git clone https://github.com/achin90/Dispatch.git
cd Dispatch
./install-from-source
```

To update, pull the latest changes and rerun:

```bash
git pull && ./install-from-source
```

### Option 3: Development mode

Runs the TypeScript source directly via Bun without a build step:

```bash
git clone https://github.com/achin90/Dispatch.git
cd Dispatch
bun install
bun run dev
bun run dev ~/Documents/workspace
bun run dev --standalone   # private server instead of the shared background service
```

The CLI lives in `packages/cli` (`bun run dev` runs `packages/cli/src/index.ts`); the Claude Agent SDK integration lives in `packages/dispatch`. In dev mode the SDK finds its own `claude` binary from `node_modules`.

---

## Usage

#### Background server

Like opencode v2, `dispatch` is a client: it connects to one per-user background server and starts it if needed. Dispatch's server is separate from a stock `opencode` install on the same machine. It has its own registration file (`~/.local/state/opencode/service-dispatch.json`), its own port and its own database, so the two never replace each other. Manage it with `dispatch service start|status|stop|restart`.

`--standalone` runs a private server that lives only as long as that TUI or `run` command.

#### Database note

Release builds store sessions in `~/.local/share/opencode/opencode-dispatch.db`; `bun run dev` uses `opencode-local.db` in the same directory. Config stays in `~/.config/opencode`. To point a release build at the dev database:

```bash
OPENCODE_DB=opencode-local.db dispatch
```

#### Updates

Dispatch never updates itself (`dispatch upgrade` and the TUI's update notice are disabled). Rerun the curl installer, or `git pull && ./install-from-source`, to update.

### Common Options

These flags work with both `bun run dev` and the built binary:

| Flag               | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `[directory]`      | Path to project directory (positional arg)                |
| `--continue`, `-c` | Continue the last session                                 |
| `--session`, `-s`  | Session ID to continue (created if it does not exist)     |
| `--prompt`         | Prompt to start with                                      |
| `--auto`           | Auto-approve permissions that are not explicitly denied   |
| `--standalone`     | Use a private server instead of the background service    |
| `--server <url>`   | Connect to another running server                         |
| `--no-dashboard`   | Skip the agent dashboard and open a session directly      |
| `--help`, `-h`     | Show help                                                 |
| `--version`, `-v`  | Show version                                              |

`--standalone` used to mean "skip the dashboard" in Dispatch v1. In v2 that flag is `--no-dashboard`.

### Subcommands

Dispatch also supports subcommands for headless/non-interactive use:

```bash
# run a single message non-interactively
bun run dev run "explain this codebase"

# pick a model and approve tool permissions automatically
bun run dev run --auto -m anthropic/opus-5-5 "explain this codebase"

# run against a private server
bun run dev run --standalone "explain this codebase"
```

`dispatch run` works in the current directory; `cd` into the project first. See `dispatch --help` for the rest (`session`, `mcp`, `auth`, `service`, `pair`, `serve`, …).

---

## Configuration

Dispatch respects the same configuration system as OpenCode. Config files use **JSON** or **JSONC** (JSON with Comments) format and are merged together, with later sources overriding earlier ones.

For full documentation see the **[OpenCode configuration docs](https://opencode.ai/docs/config/)**.

### Config File Locations (by precedence)

| Priority | Source            | Location                                                               |
| -------- | ----------------- | ---------------------------------------------------------------------- |
| 1        | Remote config     | `.well-known/opencode` endpoint (organizational defaults)              |
| 2        | Global config     | `~/.config/opencode/opencode.json`                                     |
| 3        | Custom config     | Path specified via `OPENCODE_CONFIG` env var                           |
| 4        | Project config    | `opencode.json` in project root                                        |
| 5        | Directory configs | `.opencode/` subdirectories (`agents/`, `commands/`, `plugins/`, etc.) |
| 6        | Inline config     | `OPENCODE_CONFIG_CONTENT` env var                                      |

### Key Configuration Options

- **`model`** -- Main LLM model (e.g., `"anthropic/claude-sonnet-4-5"`)
- **`small_model`** -- Lightweight model for tasks like title generation
- **`provider`** -- Provider configuration with timeout/cache settings
- **`disabled_providers`** / **`enabled_providers`** -- Control which providers are available
- **`tools`** -- Configure which tools the LLM can access (write, bash, edit, etc.)
- **`agent`** -- Define custom specialized agents
- **`mcp`** -- Model Context Protocol server configuration
- **`autoupdate`** -- Ignored by Dispatch, which never updates itself
- **`permission`** -- Tool approval requirements (`"ask"` for confirmation)
- **`instructions`** -- Path to custom instruction/rules files

### Variable Substitution

Config values support variable substitution:

- **Environment variables:** `{env:VARIABLE_NAME}` -- replaced with the env var value (empty string if not set)
- **File contents:** `{file:path/to/file}` -- inlines the file contents (useful for API keys stored separately)

### Schema

JSON schema files are available for editor autocompletion and validation:

- Main config: `https://opencode.ai/config.json`
- TUI config: `https://opencode.ai/tui.json`

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
