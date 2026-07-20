import { test, expect, afterEach } from "bun:test"
import os from "os"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { createSubagentPermissionHook } from "../../src/session/claude-sdk-permissions"

afterEach(async () => {
  await Instance.disposeAll()
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
const decide = (ruleset: Permission.Ruleset, evt: Record<string, unknown>) =>
  Instance.provide({
    directory: os.tmpdir(),
    fn: async () => {
      const out = (await createSubagentPermissionHook(ruleset)(evt)) as {
        continue?: boolean
        hookSpecificOutput?: { permissionDecision?: string }
      }
      return out.hookSpecificOutput?.permissionDecision ?? "passthrough"
    },
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
