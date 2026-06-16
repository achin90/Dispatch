import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"

/**
 * Path to the Claude CLI binary, or undefined to let the SDK resolve it
 * itself via createRequire(import.meta.url).resolve.
 *
 * The SDK's default resolution works in dev mode (it finds the platform
 * package in node_modules) but FAILS inside a `bun build --compile` binary:
 * import.meta.url points into $bunfs, and require.resolve from there cannot
 * reach the @anthropic-ai/claude-agent-sdk-<platform>-<arch> package on the
 * real filesystem. The SDK throws "Native CLI binary for <p>-<a> not found".
 *
 * For compiled builds, script/build.ts injects a target-specific
 * `claude-sdk-bin.gen.ts` virtual file via Bun.build's `files` option. That
 * generated file imports the matching native binary with `{ type: 'file' }`
 * so Bun embeds it into $bunfs; extractFromBunfs then copies it to a real
 * path that can be spawned as a subprocess.
 *
 * In dev mode the generated module is absent — the dynamic import throws,
 * `bin` stays undefined, and callers omit pathToClaudeCodeExecutable.
 */
let bin: string | undefined
try {
  // @ts-expect-error - generated at build time; absent in dev mode
  const mod = (await import("claude-sdk-bin.gen.ts")) as { default?: string }
  if (mod.default) bin = extractFromBunfs(mod.default)
} catch {
  // dev mode — generated file is absent; SDK will resolve binary itself
}

export default bin
