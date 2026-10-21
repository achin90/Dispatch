import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Keep tests away from the developer's real data, config and credentials.
const home = mkdtempSync(path.join(tmpdir(), "dispatch-test-"))
process.env.HOME = home
process.env.XDG_CONFIG_HOME = path.join(home, ".config")
process.env.XDG_DATA_HOME = path.join(home, ".local", "share")
process.env.XDG_CACHE_HOME = path.join(home, ".cache")
process.env.XDG_STATE_HOME = path.join(home, ".local", "state")
process.env.OPENCODE_DB = ":memory:"
delete process.env.ANTHROPIC_API_KEY
