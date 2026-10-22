import { describe, expect, test } from "bun:test"
import type { FormInfo, PermissionRequest, SessionMessageInfo } from "@opencode/client"
import { DispatchModel } from "../../src/feature-plugins/dispatch/model"

const permission = (sessionID: string, id = `per_${sessionID}`): PermissionRequest => ({
  id,
  sessionID,
  action: "shell",
  resources: ["pwd"],
})

const form = (sessionID: string): FormInfo => ({
  id: `frm_${sessionID}`,
  sessionID,
  title: "Questions",
  fields: [{ key: "q0", type: "boolean" }],
})

function status(input: {
  family?: string[]
  permissions?: Record<string, PermissionRequest[]>
  forms?: Record<string, FormInfo[]>
  running?: string[]
  messages?: Record<string, SessionMessageInfo[]>
}) {
  return DispatchModel.agentStatus({
    root: "ses_root",
    family: input.family ?? ["ses_root"],
    permissions: (id) => input.permissions?.[id],
    forms: (id) => input.forms?.[id],
    running: (id) => input.running?.includes(id) ?? false,
    messages: (id) => input.messages?.[id] ?? [],
  })
}

function assistant(
  content: Extract<SessionMessageInfo, { type: "assistant" }>["content"],
  extra: Partial<Extract<SessionMessageInfo, { type: "assistant" }>> = {},
): SessionMessageInfo {
  return {
    id: "msg_1",
    type: "assistant",
    agent: "build",
    model: { id: "opus", providerID: "anthropic" },
    content,
    time: { created: 1 },
    ...extra,
  }
}

describe("agentStatus", () => {
  test("a permission pending in a child session asks for approval on the root row", () => {
    const result = status({
      family: ["ses_root", "ses_child", "ses_grandchild"],
      permissions: { ses_grandchild: [permission("ses_grandchild")] },
      running: ["ses_root", "ses_grandchild"],
    })
    expect(result.type).toBe("approve")
    expect(DispatchModel.STATUS_LABEL[result.type]).toBe("Approve (y/n)")
    if (result.type !== "approve" || result.pending.type !== "permission") throw new Error("expected a permission")
    // The reply must target the session that asked, not the agent root.
    expect(result.pending.request.sessionID).toBe("ses_grandchild")
  })

  test("the root's own permission wins over a child's", () => {
    const result = status({
      family: ["ses_child", "ses_root"],
      permissions: { ses_child: [permission("ses_child")], ses_root: [permission("ses_root")] },
    })
    if (result.type !== "approve" || result.pending.type !== "permission") throw new Error("expected a permission")
    expect(result.pending.request.sessionID).toBe("ses_root")
  })

  test("a pending form also asks for approval, after any permission", () => {
    const onlyForm = status({ family: ["ses_root", "ses_child"], forms: { ses_child: [form("ses_child")] } })
    expect(onlyForm.type === "approve" && onlyForm.pending.type).toBe("form")
    const both = status({
      family: ["ses_root", "ses_child"],
      forms: { ses_root: [form("ses_root")] },
      permissions: { ses_child: [permission("ses_child")] },
    })
    expect(both.type === "approve" && both.pending.type).toBe("permission")
  })

  test("idle agents wait for the user", () => {
    expect(status({}).type).toBe("waiting")
    expect(DispatchModel.STATUS_LABEL.waiting).toBe("Waiting for user")
  })

  test("a running agent reports its current tool", () => {
    const result = status({
      running: ["ses_root"],
      messages: {
        ses_root: [
          assistant([
            {
              type: "tool",
              id: "call_1",
              name: "shell",
              time: { created: 1 },
              state: { status: "running", input: { command: "pwd" }, metadata: {} },
            },
          ]),
        ],
      },
    })
    expect(result).toEqual({ type: "working", activity: "Shell pwd" })
  })

  test("a running subagent counts as working when the root is between steps", () => {
    const result = status({
      family: ["ses_root", "ses_child"],
      running: ["ses_child"],
      messages: { ses_child: [assistant([{ type: "reasoning", text: "hm", time: { created: 1 } }])] },
    })
    expect(result).toEqual({ type: "working", activity: "Thinking…" })
  })

  test("a scheduled retry shows as retrying", () => {
    const result = status({
      running: ["ses_root"],
      messages: {
        ses_root: [
          assistant([], { retry: { attempt: 1, at: 2, error: { type: "provider.overloaded", message: "busy" } } }),
        ],
      },
    })
    expect(result.type).toBe("retrying")
  })
})

describe("currentActivity", () => {
  test("is empty once the assistant message completes", () => {
    expect(
      DispatchModel.currentActivity([
        assistant([{ type: "text", text: "done" }], { time: { created: 1, completed: 2 } }),
      ]),
    ).toBeUndefined()
  })

  test("names streaming text and finished reasoning", () => {
    expect(DispatchModel.currentActivity([assistant([{ type: "text", text: "hi" }])])).toBe("Writing…")
    expect(
      DispatchModel.currentActivity([
        assistant([{ type: "reasoning", text: "hm", time: { created: 1, completed: 2 } }]),
      ]),
    ).toBeUndefined()
  })
})

describe("formatActivity", () => {
  test("prefers a file's basename, then the command or pattern", () => {
    expect(DispatchModel.formatActivity("read", { filePath: "/src/session/processor.ts" })).toBe("Read processor.ts")
    expect(DispatchModel.formatActivity("edit", { file_path: "/a/b.ts", command: "x" })).toBe("Edit b.ts")
    expect(DispatchModel.formatActivity("shell", { command: "git status\ngit diff" })).toBe("Shell git status")
    expect(DispatchModel.formatActivity("grep", { pattern: "TODO" })).toBe("Grep TODO")
    expect(DispatchModel.formatActivity("glob", { foo: 1 })).toBe("Glob")
    expect(DispatchModel.formatActivity("shell", undefined)).toBe("Shell")
  })

  test("truncates long arguments", () => {
    const result = DispatchModel.formatActivity("shell", { command: "x".repeat(100) })
    expect(result.length).toBe("Shell ".length + 60)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("dashboardAction", () => {
  const cases: [DispatchModel.DashboardKey, DispatchModel.DashboardAction | undefined][] = [
    [{ name: "j" }, { type: "move", delta: 1 }],
    [{ name: "down" }, { type: "move", delta: 1 }],
    [{ name: "k" }, { type: "move", delta: -1 }],
    [{ name: "up" }, { type: "move", delta: -1 }],
    [{ name: "return" }, { type: "open" }],
    [{ name: "c" }, { type: "copy" }],
    [{ name: "a" }, { type: "add" }],
    [{ name: "w" }, { type: "worktree" }],
    [{ name: "d" }, { type: "remove" }],
    [{ name: "d", shift: true }, { type: "diff" }],
    [{ name: "D" }, { type: "diff" }],
    [{ name: "x" }, { type: "purge" }],
    [{ name: "y" }, { type: "approve" }],
    [{ name: "n" }, { type: "deny" }],
    [{ name: "t" }, { type: "terminal" }],
    [{ name: "i" }, { type: "message" }],
    [{ name: "r" }, { type: "refresh" }],
    [{ name: "p", shift: true }, { type: "createPr" }],
    [{ name: "P" }, { type: "createPr" }],
    [{ name: "p" }, undefined],
    [{ name: "o" }, { type: "copyPr" }],
    [{ name: "m", shift: true }, { type: "mergePr" }],
    [{ name: "M" }, { type: "mergePr" }],
    [{ name: "1" }, { type: "jump", index: 0 }],
    [{ name: "9" }, { type: "jump", index: 8 }],
    [{ name: "0" }, { type: "jump", index: 9 }],
    [{ name: "!" }, { type: "jump", index: 10 }],
    [
      { name: "1", shift: true },
      { type: "jump", index: 10 },
    ],
    [{ name: ")" }, { type: "jump", index: 19 }],
    [
      { name: "0", shift: true },
      { type: "jump", index: 19 },
    ],
    [{ name: "d", ctrl: true }, undefined],
    [{ name: "x", meta: true }, undefined],
    [{ name: "escape" }, undefined],
  ]
  test.each(cases)("%p", (key, action) => {
    expect(DispatchModel.dashboardAction(key)).toEqual(action)
  })

  test("hotkeys label the rows the jump keys select", () => {
    const labels = Array.from({ length: 20 }, (_, index) => DispatchModel.hotkey(index))
    expect(labels.join("")).toBe("1234567890!@#$%^&*()")
    labels.forEach((label, index) =>
      expect(DispatchModel.dashboardAction({ name: label })).toEqual({ type: "jump", index }),
    )
  })
})

describe("agent list", () => {
  const entry = (id: string, directory?: string): DispatchModel.AgentEntry => ({
    id,
    name: id,
    sessionID: `ses_${id}`,
    createdAt: 0,
    directory,
  })

  test("groups by working directory and inserts into the matching group", () => {
    const agents = [entry("a", "/repo"), entry("b", "/other"), entry("c", "/repo/")]
    expect(DispatchModel.groupAgents(agents, "/cwd").map((group) => [group.directory, group.agents.length])).toEqual([
      ["/repo", 2],
      ["/other", 1],
    ])
    const inserted = DispatchModel.insertAgent(agents, entry("d", "/other"), "/cwd")
    expect(inserted.index).toBe(2)
    expect(inserted.agents.map((agent) => agent.id)).toEqual(["a", "b", "d", "c"])
  })

  test("worktree agents work in the worktree; relative and missing directories resolve against the launch directory", () => {
    expect(DispatchModel.agentDirectory(entry("a", "."), "/cwd")).toBe("/cwd")
    expect(DispatchModel.agentDirectory(entry("a", "sub"), "/cwd")).toBe("/cwd/sub")
    expect(
      DispatchModel.agentDirectory(
        { ...entry("a", "/repo"), worktree: { branch: "b", directory: "/repo-b/", sourceRepo: "/repo" } },
        "/cwd",
      ),
    ).toBe("/repo-b")
  })

  test("agent metadata is ignored when inherited by a child or fork", () => {
    const metadata = DispatchModel.agentMetadata({ name: "Fixer", createdAt: 5 }, "ses_root")
    expect(DispatchModel.readAgentMetadata({ id: "ses_root", metadata })).toEqual({ name: "Fixer", createdAt: 5 })
    expect(DispatchModel.readAgentMetadata({ id: "ses_child", metadata })).toBeUndefined()
  })
})

describe("pull requests", () => {
  const pr = {
    number: 12,
    title: "Fix",
    state: "OPEN",
    url: "https://github.com/o/r/pull/12",
    draft: false,
    base: "main",
    checks: "pass",
    review: "APPROVED",
  } as const

  test("labels state, CI and review", () => {
    expect(DispatchModel.prLabel(pr)).toBe("PR: #12 Open ✓ CI Approved")
    expect(DispatchModel.prLabel({ ...pr, state: "MERGED" })).toBe("PR: #12 Merged ✓ CI")
    expect(DispatchModel.prLabel({ ...pr, draft: true, checks: "pending" })).toBe("PR: #12 Draft ⧗ CI")
  })

  test("merge guards", () => {
    expect(DispatchModel.mergeBlocker(pr)).toBeUndefined()
    expect(DispatchModel.mergeBlocker({ ...pr, state: "CLOSED" })).toBe("PR is closed")
    expect(DispatchModel.mergeBlocker({ ...pr, checks: "fail" })).toBe("PR not ready: CI failing")
    expect(DispatchModel.mergeBlocker({ ...pr, review: "CHANGES_REQUESTED" })).toBe("PR not ready: changes requested")
  })
})

describe("importLegacy", () => {
  test("converts v1 kv.json agents and splits their summaries", () => {
    const result = DispatchModel.importLegacy({
      theme: "x",
      agents: [
        {
          id: "a",
          name: "one",
          sessionID: "ses_1",
          createdAt: 1,
          directory: "/d",
          summary: { text: "done", ai: true },
        },
        {
          id: "b",
          name: "two",
          sessionID: "ses_2",
          createdAt: 2,
          worktree: { branch: "b", directory: "/w", sourceRepo: "/r" },
        },
        { name: "broken" },
      ],
    })
    expect(result.agents).toEqual([
      { id: "a", name: "one", sessionID: "ses_1", createdAt: 1, directory: "/d" },
      {
        id: "b",
        name: "two",
        sessionID: "ses_2",
        createdAt: 2,
        worktree: { branch: "b", directory: "/w", sourceRepo: "/r" },
      },
    ])
    expect(result.summaries).toEqual({ ses_1: { text: "done", ai: true } })
  })

  test("tolerates a missing or foreign file", () => {
    expect(DispatchModel.importLegacy(undefined)).toEqual({ agents: [], summaries: {} })
    expect(DispatchModel.importLegacy({ agents: "nope" })).toEqual({ agents: [], summaries: {} })
  })
})
