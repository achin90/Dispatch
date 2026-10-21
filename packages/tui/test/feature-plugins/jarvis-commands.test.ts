import { describe, expect, test } from "bun:test"
import {
  createCommandDispatcher,
  fuzzyMatchName,
  fuzzyMatchRepo,
  parseBareReply,
  parseCommand,
  stripWakeWord,
  toCamelCase,
  type BareReply,
  type CommandHost,
  type Focus,
} from "../../src/feature-plugins/jarvis/commands"

describe("stripWakeWord", () => {
  test("separates the body from the wake word and strips command punctuation", () => {
    expect(stripWakeWord("Jarvis, read that.")).toEqual({ body: "read that.", command: "read that" })
    expect(stripWakeWord("jarvis go home")).toEqual({ body: "go home", command: "go home" })
  })

  test("ignores phrases without the wake word or with nothing after it", () => {
    expect(stripWakeWord("read that")).toBeUndefined()
    expect(stripWakeWord("Jarvis.")).toBeUndefined()
  })
})

describe("parseCommand", () => {
  test.each([
    ["go to auth refactor", { command: "navigate", args: { target: "auth refactor" } }],
    ["open billing", { command: "navigate", args: { target: "billing" } }],
    ["go home", { command: "go-home", args: {} }],
    ["dashboard", { command: "go-home", args: {} }],
    ["message billing, add a test", { command: "message", args: { target: "billing", text: "add a test" } }],
    [
      "create agent called auth fix on dispatch",
      { command: "create-agent", args: { name: "auth fix", repo: "dispatch" } },
    ],
    ["create worktree on dispatch", { command: "create-worktree", args: { repo: "dispatch" } }],
    ["yolo mode", { command: "set-agent", args: { agent: "yolo" } }],
    ["switch to build", { command: "set-agent", args: { agent: "build" } }],
    ["yellow mode", { command: "set-agent", args: { agent: "yellow" } }],
    ["what mode am I in?", { command: "which-agent", args: {} }],
    ["what did it say", { command: "summarize-last", args: {} }],
    ["what did billing say?", { command: "summarize-last", args: { target: "billing" } }],
    ["say that again", { command: "read-last", args: {} }],
    ["voice mode off", { command: "voice-off", args: {} }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected)
  })

  test("falls back to edit distance for long misheard phrases", () => {
    expect(parseCommand("what mot am i in")).toEqual({ command: "which-agent", args: {} })
    expect(parseCommand("switch to yolo mood")).toEqual({ command: "set-agent", args: { agent: "yolo" } })
  })

  test("leaves dictation alone", () => {
    expect(parseCommand("build the migration")).toBeUndefined()
    expect(parseCommand("fix the failing test in the parser")).toBeUndefined()
  })
})

describe("parseBareReply", () => {
  test.each<[string, BareReply]>([
    ["Approve.", { decision: "once" }],
    ["okay", { decision: "once" }],
    ["always allow", { decision: "always" }],
    ["deny", { decision: "reject" }],
    ["No, use the other file.", { decision: "reject", reason: "use the other file" }],
    ["reject that is the wrong branch", { decision: "reject", reason: "that is the wrong branch" }],
  ])("%s", (text, expected) => {
    expect(parseBareReply(text)).toEqual(expected)
  })

  test("needs a separator before a denial reason", () => {
    expect(parseBareReply("nope")).toBeUndefined()
    expect(parseBareReply("notice the build")).toBeUndefined()
  })
})

describe("name matching", () => {
  const agents = [
    { name: "authRefactor", sessionID: "a" },
    { name: "billing-api", sessionID: "b" },
    { name: "docs", sessionID: "c" },
  ]

  test("matches spoken names against camelCase and kebab-case agents", () => {
    expect(fuzzyMatchName("auth refactor", agents)?.sessionID).toBe("a")
    expect(fuzzyMatchName("billing", agents)?.sessionID).toBe("b")
    expect(fuzzyMatchName("dogs", agents)?.sessionID).toBe("c")
    expect(fuzzyMatchName("kubernetes", agents)).toBeUndefined()
  })

  test("matches repositories by basename", () => {
    expect(fuzzyMatchRepo("dispatch", ["/src/other", "/src/dispatch/"])).toBe("/src/dispatch/")
  })

  test("camelCases spoken names", () => {
    expect(toCamelCase("Auth Refactor")).toBe("authRefactor")
  })
})

describe("bare utterances", () => {
  function setup(focus: Focus) {
    const replies: unknown[] = []
    const spoken: string[] = []
    const answers: string[] = []
    const host: CommandHost = {
      voice: {
        pending: () => undefined,
        waitForResponse: async () => answers.shift(),
        setMode: () => {},
      },
      speak: async (text) => void spoken.push(text),
      focus: () => focus,
      agents: () => [{ id: "1", name: "billing", sessionID: "root", createdAt: 0 }],
      open: () => {},
      home: () => {},
      agent: { current: () => "build", list: () => ["build"], set: () => {} },
      sessionAgent: () => undefined,
      prompt: async () => {},
      // The request belongs to a subagent of the root session.
      permission: (sessionID) => (sessionID === "root" ? { id: "perm", sessionID: "child" } : undefined),
      reply: async (request, decision, message) => void replies.push({ request, decision, message }),
      summary: async () => undefined,
      lastResponse: async () => undefined,
      repositories: async () => [],
      createAgent: async () => ({ sessionID: "new" }),
      createWorktree: async () => ({ sessionID: "new" }),
    }
    return { dispatcher: createCommandDispatcher(host), replies, spoken, answers }
  }

  test("approves the pending permission in the open session's family", async () => {
    const env = setup({ type: "session", sessionID: "child", root: "root" })
    expect(await env.dispatcher.handleBareUtterance("Yes.")).toBe(true)
    expect(env.replies).toEqual([{ request: { id: "perm", sessionID: "child" }, decision: "once", message: undefined }])
  })

  test("asks for a reason when a denial has none", async () => {
    const env = setup({ type: "dashboard", selected: "root" })
    env.answers.push("wrong directory")
    expect(await env.dispatcher.handleBareUtterance("deny")).toBe(true)
    expect(env.spoken).toEqual(["Why are you denying this?"])
    expect(env.replies).toEqual([
      { request: { id: "perm", sessionID: "child" }, decision: "reject", message: "wrong directory" },
    ])
  })

  test("is not consumed without a pending permission", async () => {
    const env = setup({ type: "other" })
    expect(await env.dispatcher.handleBareUtterance("yes")).toBe(false)
    expect(env.replies).toEqual([])
  })
})
