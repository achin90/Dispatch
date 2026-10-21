import { describe, expect, test } from "bun:test"
import type { CanUseTool, HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { SessionMessage } from "@opencode/core/session/message"
import { DateTime } from "effect"
import { SdkLanguageModel } from "../src/sdk/language-model"
import { SdkEnv } from "../src/sdk/env"
import { SdkSessionMap } from "../src/sdk/session-map"
import { SdkQuery } from "../src/runner/query"

const time = { created: DateTime.makeUnsafe(0) }
const user = (text: string, files?: SessionMessage.User["files"]) =>
  ({ id: SessionMessage.ID.create(), type: "user", text, files, time }) as SessionMessage.Info
const assistant = () =>
  ({ id: SessionMessage.ID.create(), type: "assistant", content: [], time }) as unknown as SessionMessage.Info

describe("turn input", () => {
  test("a turn answers every user or synthetic message after the last reply", () => {
    const messages = [user("old"), assistant(), user("first"), user("steered")]
    expect(SdkQuery.pending(messages).map((message) => (message as SessionMessage.User).text)).toEqual([
      "first",
      "steered",
    ])
    expect(SdkQuery.pending([user("a"), assistant()])).toEqual([])
  })

  test("plain text prompts join the pending messages", () => {
    expect(SdkQuery.prompt([user("one"), user("two")])).toBe("one\n\ntwo")
  })

  test("images and PDFs become content blocks; text attachments are inlined", () => {
    const prompt = SdkQuery.prompt([
      user("look", [
        { data: "aW1n", mime: "image/png", source: { type: "inline" }, name: "a.png" },
        { data: "cGRm", mime: "application/pdf", source: { type: "inline" }, name: "b.pdf" },
        {
          data: Buffer.from("hello").toString("base64"),
          mime: "text/plain",
          source: { type: "inline" },
          name: "c.txt",
        },
      ] as SessionMessage.User["files"]),
    ])
    expect(typeof prompt).toBe("object")
    if (typeof prompt === "string") return
    expect(prompt.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
      { type: "text", text: 'look\n\n<file name="c.txt">\nhello\n</file>' },
    ])
  })
})

describe("query options", () => {
  const base = {
    model: "claude-opus-5-5[1m]",
    systemPrompt: "system",
    cwd: "/repo",
    contextWindow: 1_000_000,
    abortController: new AbortController(),
    canUseTool: (async () => ({ behavior: "allow" })) as CanUseTool,
    preToolUse: (async () => ({ continue: true })) as HookCallback,
    postCompact: (async () => ({ continue: true })) as HookCallback,
    mcpServers: {},
  }

  test("keep canUseTool in charge, isolate MCP, clamp the compact window", () => {
    const options = SdkQuery.options({ ...base, contextWindow: 2_000_000, resume: "uuid", effort: "xhigh" })
    expect(options.permissionMode).toBe("default")
    expect(options.strictMcpConfig).toBe(true)
    expect(options.resume).toBe("uuid")
    expect(options.effort).toBe("xhigh")
    expect(options.includePartialMessages).toBe(true)
    expect((options.settings as { autoCompactWindow: number }).autoCompactWindow).toBe(1_000_000)
    expect(
      (SdkQuery.options({ ...base, contextWindow: 50_000 }).settings as { autoCompactWindow: number })
        .autoCompactWindow,
    ).toBe(100_000)
  })

  test("advisor and effort are passed only when set and valid", () => {
    expect(
      (SdkQuery.options({ ...base, advisorModel: "opus" }).settings as { advisorModel?: string }).advisorModel,
    ).toBe("opus")
    expect(SdkQuery.options(base).settings).not.toHaveProperty("advisorModel")
    expect(SdkQuery.options({ ...base, effort: "default" })).not.toHaveProperty("effort")
  })

  test("a stale resume is recognized", () => {
    expect(SdkQuery.isStaleResume("No conversation found with session ID: abc")).toBe(true)
    expect(SdkQuery.isStaleResume("rate limited")).toBe(false)
  })
})

describe("CLI environment", () => {
  test("sets the first-party and tool-search flags, the API key, and strips nested-session variables", () => {
    const env: Record<string, string | undefined> = SdkEnv.build({
      apiKey: "sk-test",
      base: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", AI_AGENT: "x", HOME: "/h" },
    })
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      ENABLE_TOOL_SEARCH: "false",
      ANTHROPIC_API_KEY: "sk-test",
    })
    expect(SdkEnv.build({ base: {} })).not.toHaveProperty("ANTHROPIC_API_KEY")
  })
})

describe("session map", () => {
  test("an entry is honoured only by the Session that owns it", () => {
    const metadata = { [SdkSessionMap.KEY]: { sessionID: "ses_a", uuid: "u1", cwd: "/repo" } }
    expect(SdkSessionMap.read({ id: "ses_a" as never, metadata })).toEqual({ uuid: "u1", cwd: "/repo" })
    // Children and forks inherit metadata; they must not resume the parent's conversation.
    expect(SdkSessionMap.read({ id: "ses_child" as never, metadata })).toBeUndefined()
    expect(SdkSessionMap.read({ id: "ses_a" as never, metadata: undefined })).toBeUndefined()
  })
})

describe("single-shot language model", () => {
  test("renders system messages as the system prompt and a lone user message verbatim", () => {
    expect(
      SdkLanguageModel.render([
        { role: "system", content: "Write a title" },
        { role: "user", content: [{ type: "text", text: "fix the bug" }] },
      ]),
    ).toEqual({ system: "Write a title", prompt: "fix the bug" })
  })

  test("renders a conversation as a transcript", () => {
    expect(
      SdkLanguageModel.render([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: [{ type: "text", text: "summarize" }] },
      ]).prompt,
    ).toBe("User: hi\n\nAssistant: hello\n\nUser: summarize")
  })
})
