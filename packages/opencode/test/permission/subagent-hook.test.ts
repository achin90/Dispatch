import { test, expect, afterEach } from "bun:test"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { WithInstance } from "@/project/with-instance"
import os from "os"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Instance } from "../../src/project/instance"
import { createSubagentPermissionHook } from "../../src/session/claude-sdk-permissions"

afterEach(async () => {
  await AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))
})

const defaults = Permission.fromConfig({
  "*": "allow",
  external_directory: { "*": "ask" },
  read: { "*": "allow", "*.env": "ask" },
})
const yolo = Permission.merge(defaults, Permission.fromConfig({ "*": "allow" }))
const build = Permission.merge(defaults, Permission.fromConfig({ bash: "ask", edit: "ask", write: "ask" }))

// createSubagentPermissionHook binds the current Instance ALS context, so build
// the hook and call it inside Instance.provide (mirrors production, where it is
// constructed within the session's instance context).
const decide = (ruleset: PermissionV1.Ruleset, evt: Record<string, unknown>) =>
  WithInstance.provide({
    directory: os.tmpdir(),
    fn: async () => {
      const out = (await createSubagentPermissionHook(ruleset)(evt)) as {
        continue?: boolean
        hookSpecificOutput?: { permissionDecision?: string }
      }
      return out.hookSpecificOutput?.permissionDecision ?? "passthrough"
    },
  })

// Same binding requirement as `decide`, but returns the rewritten tool input
// rather than the permission decision.
const rewrite = (ruleset: PermissionV1.Ruleset, evt: Record<string, unknown>) =>
  WithInstance.provide({
    directory: os.tmpdir(),
    fn: async () => {
      const out = (await createSubagentPermissionHook(ruleset)(evt)) as {
        hookSpecificOutput?: { updatedInput?: Record<string, unknown> }
      }
      return out.hookSpecificOutput?.updatedInput
    },
  })

test("Agent calls are forced to run synchronously", async () => {
  // The SDK backgrounds subagents by default, which we have no support for: the
  // task outlives the turn, the subprocess dies with the turn, and the orphaned
  // subagent's tool calls are cancelled before reaching any permission path.
  const input = { description: "find the thing", prompt: "go", subagent_type: "Explore" }
  expect(await rewrite(build, { tool_name: "Agent", tool_input: input })).toEqual({
    ...input,
    run_in_background: false,
  })
})

test("Agent rewrite preserves the rest of the tool input", async () => {
  const updated = await rewrite(build, {
    tool_name: "Agent",
    tool_input: { prompt: "go", subagent_type: "Explore", model: "opus" },
  })
  expect(updated?.prompt).toBe("go")
  expect(updated?.subagent_type).toBe("Explore")
  expect(updated?.model).toBe("opus")
})

test("Agent calls already synchronous are left alone", async () => {
  expect(await rewrite(build, { tool_name: "Agent", tool_input: { prompt: "go", run_in_background: false } })).toBe(
    undefined,
  )
})

test("non-Agent tools are not rewritten", async () => {
  expect(await rewrite(build, { tool_name: "Bash", tool_input: { command: "ls" } })).toBe(undefined)
})

test("main-thread calls (no agent_id) are passed through to canUseTool", async () => {
  expect(await decide(build, { tool_name: "Bash", tool_input: { command: "rm -rf /" } })).toBe("passthrough")
})

test("yolo parent → subagent bash / external read / external write all allowed", async () => {
  expect(await decide(yolo, { agent_id: "a1", tool_name: "Bash", tool_input: { command: "ls" } })).toBe("allow")
  expect(
    await decide(yolo, { agent_id: "a1", tool_name: "Read", tool_input: { file_path: "/Users/x/.claude/foo.jsonl" } }),
  ).toBe("allow")
  expect(await decide(yolo, { agent_id: "a1", tool_name: "Write", tool_input: { file_path: "/tmp/out.txt" } })).toBe(
    "allow",
  )
})

test("build parent → subagent bash/edit resolve to ask (auto-deny); read allowed", async () => {
  expect(await decide(build, { agent_id: "a1", tool_name: "Bash", tool_input: { command: "ls" } })).toBe("ask")
  expect(await decide(build, { agent_id: "a1", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } })).toBe(
    "ask",
  )
  expect(await decide(build, { agent_id: "a1", tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } })).toBe(
    "allow",
  )
})

test("explicit deny rule wins even under a yolo parent", async () => {
  const restricted = Permission.merge(yolo, Permission.fromConfig({ bash: { "*": "deny" } }))
  expect(await decide(restricted, { agent_id: "a1", tool_name: "Bash", tool_input: { command: "ls" } })).toBe("deny")
})
