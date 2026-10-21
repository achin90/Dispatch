export * as SdkBin from "./bin.js"

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"

let resolved: Promise<string | undefined> | undefined

/**
 * Path to the embedded `claude` executable, or undefined to let the SDK resolve its own.
 *
 * Compiled builds inject `src/sdk/bin.gen.ts`, whose default export is the Bun-embedded path of
 * the CLI binary from `@anthropic-ai/claude-agent-sdk-<os>-<arch>` (`import bin from "<abs>" with
 * { type: "file" }`). The SDK cannot spawn from `$bunfs`, so the binary is extracted to a real path.
 * In dev the module is absent and the SDK finds the platform package in node_modules itself.
 */
export function resolveClaudeBin() {
  resolved ??= import(
    // @ts-ignore generated at build time; absent in dev
    "./bin.gen.ts"
  ).then(
    (module: { readonly default?: unknown }) =>
      typeof module.default === "string" ? extractFromBunfs(module.default) : undefined,
    () => undefined,
  )
  return resolved
}
