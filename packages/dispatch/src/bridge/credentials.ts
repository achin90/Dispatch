export * as BridgeCredentials from "./credentials.js"

import os from "node:os"
import path from "node:path"

/** The scope that gates claude.ai code sessions server-side. */
export const SCOPE = "user:sessions:claude_code"
export const KEYCHAIN_SERVICE = "Claude Code-credentials"

export type Result = { readonly token: string } | { readonly reason: string }

export interface Options {
  readonly home?: string
  /** Reads the macOS Keychain entry. Injectable so tests never spawn `security`. */
  readonly keychain?: () => Promise<unknown>
  readonly now?: number
}

/**
 * The claude.ai OAuth bearer the bridge authenticates with: the credential the Claude CLI stores
 * after `claude login`. This is not an inference API key, which the bridge cannot use.
 *
 * Linux and Windows keep it in `~/.claude/.credentials.json`; macOS keeps the same JSON in the
 * login Keychain and never writes the file.
 */
export async function read(options: Options = {}): Promise<Result> {
  const file = await Bun.file(path.join(options.home ?? os.homedir(), ".claude", ".credentials.json"))
    .json()
    .catch(() => undefined)
  if (file !== undefined) return check(file, options.now)
  if (!options.keychain && process.platform !== "darwin")
    return { reason: "No Claude Code login found. Run `claude login`." }
  const stored = await (options.keychain ?? keychain)()
  if (stored === undefined) return { reason: "No Claude Code login found in the Keychain. Run `claude login`." }
  return check(stored, options.now)
}

/** Requires a non-expired `claudeAiOauth.accessToken` that carries the code-sessions scope. */
export function check(credentials: unknown, now = Date.now()): Result {
  const oauth = record(record(credentials)?.claudeAiOauth)
  const token = oauth?.accessToken
  if (typeof token !== "string" || token === "")
    return { reason: "No claude.ai OAuth credential found. Run `claude login`." }
  if (typeof oauth?.expiresAt === "number" && oauth.expiresAt < now)
    return { reason: "The claude.ai OAuth credential has expired. Run `claude login`." }
  if (Array.isArray(oauth?.scopes) && !oauth.scopes.includes(SCOPE))
    return { reason: `The claude.ai OAuth credential lacks the ${SCOPE} scope. Run \`claude login\` again.` }
  return { token }
}

async function keychain() {
  const security = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const parsed: unknown = await new Response(security.stdout).json().catch(() => undefined)
  if ((await security.exited) !== 0) return undefined
  return parsed
}

function record(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
