/**
 * Wrapper around the Claude Agent SDK's query() function that:
 * 1. Resolves the Anthropic API key from the existing auth system or env
 * 2. Sets up the canUseTool permission bridge
 * 3. Calls query() with proper options
 * 4. Returns the message stream for processClaudeSdkStream()
 */

import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk"
import { Auth } from "@/auth"
import { SessionID } from "@/session/schema"
import { createCanUseToolBridge } from "./claude-sdk-permissions"

export interface ClaudeSdkQueryInput {
  prompt: string
  sessionID: SessionID
  model?: string
  systemPrompt?: string
  cwd?: string
  permissionMode?: Options["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  abortController?: AbortController
  maxTurns?: number
}

/**
 * Resolves the Anthropic API key from:
 * 1. ANTHROPIC_API_KEY environment variable (already set)
 * 2. The Auth store (auth.json) for the "anthropic" provider
 *
 * Returns undefined if no key is found — the Agent SDK will try
 * OAuth/subscription login in that case.
 */
export async function resolveApiKey(): Promise<string | undefined> {
  // Check env first
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY
  }

  // Check auth store
  const authInfo = await Auth.get("anthropic")
  if (authInfo?.type === "api") {
    return authInfo.key
  }

  // No API key found — the Agent SDK will attempt OAuth/subscription
  return undefined
}

/**
 * Creates a Claude Agent SDK query() call wired with:
 * - API key from the existing auth system
 * - Permission bridge to the TUI
 * - Model and system prompt configuration
 */
export async function createClaudeSdkQuery(
  input: ClaudeSdkQueryInput,
): Promise<Query> {
  const apiKey = await resolveApiKey()

  const env: Record<string, string | undefined> = {
    ...process.env,
  }
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey
  }

  const options: Options = {
    model: input.model,
    systemPrompt: input.systemPrompt,
    cwd: input.cwd ?? process.cwd(),
    env,
    betas: ["context-1m-2025-08-07"],
    permissionMode: input.permissionMode ?? "default",
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    canUseTool: createCanUseToolBridge({ sessionID: input.sessionID }),
    abortController: input.abortController,
    maxTurns: input.maxTurns,
  }

  return query({
    prompt: input.prompt,
    options,
  })
}
