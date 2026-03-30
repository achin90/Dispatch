/**
 * Manual integration test — run directly with `bun run test/claude-sdk/manual-test.ts`
 * (NOT via `bun test`, which runs preload.ts and clears env vars)
 *
 * Tests the full round trip with whatever auth is available on the machine
 * (API key OR subscription login).
 */

import { query } from "@anthropic-ai/claude-agent-sdk"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

async function main() {
  console.log("Starting Claude Agent SDK manual test...")
  console.log("Auth: using whatever credentials are on this machine (API key or subscription)")
  console.log("")

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    console.error("Timed out after 60s")
    controller.abort()
    process.exit(1)
  }, 60000)

  try {
    const stream = query({
      prompt: "What is 2+2? Reply with just the number, nothing else.",
      options: {
        model: "claude-sonnet-4-20250514",
        permissionMode: "plan",
        maxTurns: 1,
        abortController: controller,
      },
    })

    const messages: SDKMessage[] = []
    for await (const msg of stream) {
      messages.push(msg)
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            console.log(`[system] init — model: ${msg.model}, tools: ${msg.tools.length}, apiKeySource: ${msg.apiKeySource}`)
          }
          break
        case "assistant":
          const blocks = msg.message.content.map((b) => b.type).join(", ")
          console.log(`[assistant] content blocks: [${blocks}]`)
          for (const block of msg.message.content) {
            if (block.type === "text") {
              console.log(`  text: "${block.text}"`)
            }
          }
          break
        case "result":
          console.log(`[result] subtype: ${msg.subtype}, turns: ${msg.num_turns}, cost: $${msg.total_cost_usd}`)
          if (msg.subtype === "success") {
            console.log(`  result: "${msg.result}"`)
          } else {
            console.log(`  errors: ${msg.errors}`)
          }
          break
        default:
          console.log(`[${msg.type}] (ignored)`)
          break
      }
    }

    // Verify we got the expected message types
    const types = messages.map((m) => m.type)
    console.log("")
    console.log(`Message types received: [${types.join(", ")}]`)

    const hasSystem = types.includes("system")
    const hasAssistant = types.includes("assistant")
    const hasResult = types.includes("result")

    if (hasSystem && hasAssistant && hasResult) {
      console.log("✓ All expected message types received")
    } else {
      console.error("✗ Missing expected message types")
      if (!hasSystem) console.error("  - missing: system")
      if (!hasAssistant) console.error("  - missing: assistant")
      if (!hasResult) console.error("  - missing: result")
      process.exit(1)
    }

    // Verify result is success
    const result = messages.find((m) => m.type === "result") as any
    if (result.subtype === "success") {
      console.log("✓ Result is success")
    } else {
      console.error(`✗ Result is ${result.subtype}: ${result.errors}`)
      process.exit(1)
    }

    console.log("")
    console.log("All checks passed!")

  } catch (err) {
    console.error("Error:", err)
    process.exit(1)
  } finally {
    clearTimeout(timeout)
  }
}

main()
