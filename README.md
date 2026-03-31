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

## Prerequisites

- [Bun](https://bun.sh) v1.3.11 or later

## Installation

This fork is not published to npm. Clone and build from source:

```bash
git clone https://github.com/<your-org>/Dispatch.git
cd Dispatch
bun install
```

---

## Running

There are two ways to run Dispatch locally: development mode and building from source.

### Option 1: Development Mode

Runs the TypeScript source directly via Bun without a build step. This is the fastest way to get started.

From the repository root:

```bash
bun run dev
```

To open Dispatch in a specific project directory, pass the path as an argument:

```bash
bun run dev ~/Documents/workspace
```

### Option 2: Build and Run

Compiles Dispatch into a standalone binary. Useful for testing production builds or running without Bun installed.

From the `packages/opencode` directory:

```bash
cd packages/opencode
bun run build --single
```

The `--single` flag builds only for your current platform. Without it, the build produces binaries for all supported platforms (linux, darwin, windows across arm64/x64).

The binary is output to `packages/opencode/dist/opencode-<os>-<arch>/bin/opencode`. For example on an Apple Silicon Mac:

```bash
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

To open a specific project directory:

```bash
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode ~/Documents/workspace
```

### Common Options

These flags work with both `bun run dev` and the built binary:

| Flag | Description |
| --- | --- |
| `[project]` | Path to project directory (positional arg) |
| `--model`, `-m` | Model to use in the format `provider/model` |
| `--continue`, `-c` | Continue the last session |
| `--session`, `-s` | Session ID to continue |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

### Subcommands

Dispatch also supports subcommands for headless/non-interactive use:

```bash
# run a single message non-interactively
bun run dev -- run "explain this codebase"

# run in a specific directory non-interactively
bun run dev -- run --dir ~/Documents/workspace "explain this codebase"
```

---

## Configuration

Dispatch respects the same configuration system as OpenCode. Config files use **JSON** or **JSONC** (JSON with Comments) format and are merged together, with later sources overriding earlier ones.

For full documentation see the **[OpenCode configuration docs](https://opencode.ai/docs/config/)**.

### Config File Locations (by precedence)

| Priority | Source | Location |
| --- | --- | --- |
| 1 | Remote config | `.well-known/opencode` endpoint (organizational defaults) |
| 2 | Global config | `~/.config/opencode/opencode.json` |
| 3 | Custom config | Path specified via `OPENCODE_CONFIG` env var |
| 4 | Project config | `opencode.json` in project root |
| 5 | Directory configs | `.opencode/` subdirectories (`agents/`, `commands/`, `plugins/`, etc.) |
| 6 | Inline config | `OPENCODE_CONFIG_CONTENT` env var |

### Key Configuration Options

- **`model`** -- Main LLM model (e.g., `"anthropic/claude-sonnet-4-5"`)
- **`small_model`** -- Lightweight model for tasks like title generation
- **`provider`** -- Provider configuration with timeout/cache settings
- **`disabled_providers`** / **`enabled_providers`** -- Control which providers are available
- **`tools`** -- Configure which tools the LLM can access (write, bash, edit, etc.)
- **`agent`** -- Define custom specialized agents
- **`mcp`** -- Model Context Protocol server configuration
- **`autoupdate`** -- Auto-update handling (`true`/`false`/`"notify"`)
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
