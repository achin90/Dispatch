import { describe, expect, test } from "bun:test"
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Form } from "@opencode/core/form"
import { Permission } from "@opencode/core/permission"
import { SessionMessage } from "@opencode/core/session/message"
import { Effect, Exit } from "effect"
import { SdkPermission } from "../src/runner/permission"
import { SdkAdapter } from "../src/sdk/adapter"
import { agent, location, pending, sessionID, setup } from "./fixture"

const fixture = location()

/** Builds the bridge from the Location context and calls it from outside the fiber. */
const bridge = Effect.fn("test.bridge")(function* (rules: Permission.Ruleset) {
  yield* setup(fixture.directory, rules)
  const services = yield* Effect.context<SdkPermission.Requirements>()
  const directory = SdkPermission.directory()
  const metadata = new Map()
  const declines = { count: 0 }
  const options = {
    sessionID,
    agent,
    onDecline: () => {
      declines.count++
    },
    run: <A, E>(effect: Effect.Effect<A, E, SdkPermission.Requirements>, signal?: AbortSignal) =>
      Effect.runPromiseWith(services)(effect, { signal }),
    directory,
    metadata,
  }
  const canUseTool = SdkPermission.canUseTool(options)
  const call = (tool: string, input: Record<string, unknown>, signal = new AbortController().signal) => {
    const toolUseID = `toolu_${crypto.randomUUID()}`
    directory.register(toolUseID, { sessionID, messageID: SessionMessage.ID.create() })
    return { toolUseID, answer: canUseTool(tool, input, { signal, toolUseID, requestId: "req" }) }
  }
  return { call, metadata, declines, hook: SdkPermission.subagentHook(options) }
})

const reply = (input: Omit<Permission.ReplyInput, "requestID">) =>
  Effect.gen(function* () {
    const request = yield* pending()
    yield* (yield* Permission.Service).reply({ requestID: request.id, ...input })
    return request
  })

// The SDK's CanUseTool type allows null ("no decision"); the bridge always decides.
const answer = (promise: Promise<PermissionResult | null>) =>
  Effect.promise(() => promise).pipe(
    Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.die(new Error("no decision")))),
  )

describe("canUseTool bridge", () => {
  test("once allows the call with its input", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "shell", resource: "*", effect: "ask" }])
        const { answer: decided } = call("Bash", { command: "ls -la" })
        const request = yield* reply({ reply: "once" })
        expect(request.action).toBe("shell")
        expect(request.resources).toEqual(["ls -la"])
        return yield* answer(decided)
      }),
    )
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } })
  })

  test("always saves the approval so the next call is not asked", async () => {
    const second = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "webfetch", resource: "*", effect: "ask" }])
        const first = call("WebFetch", { url: "https://example.com" })
        yield* reply({ reply: "always" })
        expect((yield* answer(first.answer)).behavior).toBe("allow")
        return yield* answer(call("WebFetch", { url: "https://example.com/other" }).answer)
      }),
    )
    expect(second.behavior).toBe("allow")
  })

  test("a plain reject denies and interrupts the turn, as a v2 decline ends the step", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call, declines } = yield* bridge([{ action: "edit", resource: "*", effect: "ask" }])
        const decided = call("Edit", { file_path: `${fixture.directory}/a.ts`, old_string: "a", new_string: "b" })
        yield* reply({ reply: "reject" })
        const result = yield* answer(decided.answer)
        // The runner ends the step as interrupted once a call is declined.
        expect(declines.count).toBe(1)
        return result
      }),
    )
    expect(result).toEqual({ behavior: "deny", message: "The user declined this tool call", interrupt: true })
  })

  test("reject with feedback keeps the turn going with the feedback", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call, declines } = yield* bridge([{ action: "shell", resource: "*", effect: "ask" }])
        const decided = call("Bash", { command: "rm -rf build" })
        yield* reply({ reply: "reject", message: "use the clean script" })
        const result = yield* answer(decided.answer)
        expect(declines.count).toBe(0)
        return result
      }),
    )
    expect(result).toEqual({
      behavior: "deny",
      message: "User rejected permission with the following feedback: use the clean script",
    })
  })

  test("a deny rule blocks without asking", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "shell", resource: "*", effect: "deny" }])
        const decided = yield* answer(call("Bash", { command: "ls" }).answer)
        expect(yield* (yield* Permission.Service).list()).toEqual([])
        return decided
      }),
    )
    expect(result.behavior).toBe("deny")
  })

  test("an allow rule allows without asking", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "*", resource: "*", effect: "allow" }])
        return yield* answer(call("Grep", { pattern: "TODO" }).answer)
      }),
    )
    expect(result).toEqual({ behavior: "allow", updatedInput: { pattern: "TODO" } })
  })

  test("v2's subagent tool is allowed here because it asks for itself", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        // Rules that would ask for anything: the bridge must not prompt for the subagent call.
        const { call } = yield* bridge([{ action: "*", resource: "*", effect: "ask" }])
        const decided = yield* answer(call(SdkAdapter.PLUGIN_SUBAGENT, { agent: "general" }).answer)
        expect(yield* (yield* Permission.Service).list()).toEqual([])
        return decided
      }),
    )
    expect(result).toEqual({ behavior: "allow", updatedInput: { agent: "general" } })
  })

  test("a call whose signal is already aborted is denied without asking", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "shell", resource: "*", effect: "ask" }])
        const abort = new AbortController()
        abort.abort()
        const outcome = yield* answer(call("Bash", { command: "ls" }, abort.signal).answer)
        const permission = yield* Permission.Service
        return { outcome, pending: yield* permission.list() }
      }),
    )
    expect(result.outcome).toEqual({ behavior: "deny", message: "Request aborted" })
    expect(result.pending).toEqual([])
  })

  test("an abort while asking denies and removes the pending request", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const { call } = yield* bridge([{ action: "shell", resource: "*", effect: "ask" }])
        const abort = new AbortController()
        const decided = call("Bash", { command: "sleep 100" }, abort.signal)
        yield* pending()
        abort.abort()
        const outcome = yield* Effect.promise(() =>
          decided.answer.then(
            (value): PermissionResult => value ?? { behavior: "deny", message: "no decision" },
            (): PermissionResult => ({ behavior: "deny", message: "rejected" }),
          ),
        )
        for (let attempt = 0; attempt < 100 && (yield* (yield* Permission.Service).list()).length > 0; attempt++)
          yield* Effect.sleep(10)
        expect(yield* (yield* Permission.Service).list()).toEqual([])
        return outcome
      }),
    )
    expect(result.behavior).toBe("deny")
  })

  test("Edit diffs are computed before approval and kept for the tool part", async () => {
    await Bun.write(`${fixture.directory}/edit.txt`, "one\ntwo\n")
    const metadata = await fixture.run(
      Effect.gen(function* () {
        const bridged = yield* bridge([{ action: "edit", resource: "*", effect: "ask" }])
        const decided = bridged.call("Edit", {
          file_path: `${fixture.directory}/edit.txt`,
          old_string: "two",
          new_string: "three",
        })
        const request = yield* reply({ reply: "once" })
        yield* answer(decided.answer)
        expect(request.resources).toEqual(["edit.txt"])
        return bridged.metadata.get(decided.toolUseID)
      }),
    )
    expect(metadata.files[0].file).toBe("edit.txt")
    expect(metadata.files[0].patch).toContain("-two")
    expect(metadata.files[0].patch).toContain("+three")
  })

  test("AskUserQuestion becomes a question form and returns the answers", async () => {
    const result = await fixture.run(
      Effect.gen(function* () {
        const bridged = yield* bridge([{ action: "*", resource: "*", effect: "allow" }])
        const decided = bridged.call("AskUserQuestion", {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [
                { label: "Postgres", description: "relational" },
                { label: "SQLite", description: "embedded" },
              ],
              multiSelect: false,
            },
          ],
        })
        const forms = yield* Form.Service
        const form = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt++) {
            const [found] = yield* forms.list()
            if (found) return found
            yield* Effect.sleep(10)
          }
          return yield* Effect.die(new Error("no form"))
        })
        expect(form.metadata?.kind).toBe("question")
        expect(form.fields[0].key).toBe("q0")
        yield* forms.reply({ id: form.id, answer: { q0: "SQLite" } })
        const decision = yield* answer(decided.answer)
        expect(bridged.metadata.get(decided.toolUseID)).toEqual({ answers: [["SQLite"]] })
        return decision
      }),
    )
    expect(result.behavior).toBe("allow")
    if (result.behavior === "allow") expect(result.updatedInput?.answers).toEqual({ "Which database?": "SQLite" })
  })
})

describe("decision", () => {
  test("maps exits to SDK permission results", () => {
    expect(SdkPermission.decision(Exit.void, { a: 1 })).toEqual({ behavior: "allow", updatedInput: { a: 1 } })
    expect(SdkPermission.decision(Exit.die(new Permission.DeclinedError()), {})).toMatchObject({ interrupt: true })
    expect(SdkPermission.decision(Exit.fail(new Permission.CorrectedError({ feedback: "no" })), {})).toEqual({
      behavior: "deny",
      message: "User rejected permission with the following feedback: no",
    })
  })
})

describe("subagent hook", () => {
  const yolo: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
  const build: Permission.Ruleset = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "ask" },
  ]
  type HookOutput = {
    hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> }
  }
  const event = (input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse" as const,
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: fixture.directory,
    tool_use_id: "toolu_hook",
    tool_name: "Bash",
    tool_input: {},
    ...input,
  })
  const decide = (rules: Permission.Ruleset, input: Record<string, unknown>) =>
    fixture.run(
      Effect.gen(function* () {
        const { hook } = yield* bridge(rules)
        const output = (yield* Effect.promise(() =>
          hook(event(input), "toolu_hook", { signal: new AbortController().signal }),
        )) as HookOutput
        return output.hookSpecificOutput
      }),
    )

  test("Agent calls are forced to run synchronously, keeping the rest of the input", async () => {
    const input = { description: "find it", prompt: "go", subagent_type: "Explore", model: "opus" }
    expect((await decide(build, { tool_name: "Agent", tool_input: input }))?.updatedInput).toEqual({
      ...input,
      run_in_background: false,
    })
  })

  test("Agent calls already synchronous and other tools are left alone", async () => {
    expect(
      await decide(build, { tool_name: "Agent", tool_input: { prompt: "go", run_in_background: false } }),
    ).toBeUndefined()
    expect(await decide(build, { tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined()
  })

  test("background Bash runs in the foreground, on the main thread and in subagents", async () => {
    const input = { command: "bun test", description: "Run tests", run_in_background: true }
    expect((await decide(build, { tool_name: "Bash", tool_input: input }))?.updatedInput).toEqual({
      ...input,
      run_in_background: false,
    })
    // A subagent's shell call keeps its permission decision alongside the rewritten input.
    expect(await decide(yolo, { agent_id: "a1", tool_name: "Bash", tool_input: input })).toMatchObject({
      permissionDecision: "allow",
      updatedInput: { ...input, run_in_background: false },
    })
  })

  test("main-thread calls pass through to canUseTool", async () => {
    expect(await decide(build, { tool_name: "Bash", tool_input: { command: "rm -rf /" } })).toBeUndefined()
  })

  test("a yolo parent allows subagent shell, read and external writes", async () => {
    const run = (input: Record<string, unknown>) => decide(yolo, { agent_id: "a1", ...input })
    expect((await run({ tool_name: "Bash", tool_input: { command: "ls" } }))?.permissionDecision).toBe("allow")
    expect(
      (await run({ tool_name: "Read", tool_input: { file_path: `${fixture.directory}/x.ts` } }))?.permissionDecision,
    ).toBe("allow")
    expect((await run({ tool_name: "Write", tool_input: { file_path: "/tmp/out.txt" } }))?.permissionDecision).toBe(
      "allow",
    )
  })

  test("a build parent asks for subagent shell and edits but allows reads", async () => {
    const run = (input: Record<string, unknown>) => decide(build, { agent_id: "a1", ...input })
    expect((await run({ tool_name: "Bash", tool_input: { command: "ls" } }))?.permissionDecision).toBe("ask")
    expect(
      (await run({ tool_name: "Edit", tool_input: { file_path: `${fixture.directory}/a.ts` } }))?.permissionDecision,
    ).toBe("ask")
    expect(
      (await run({ tool_name: "Read", tool_input: { file_path: `${fixture.directory}/a.ts` } }))?.permissionDecision,
    ).toBe("allow")
  })

  test("an explicit deny wins even under a yolo parent", async () => {
    const restricted: Permission.Ruleset = [...yolo, { action: "shell", resource: "*", effect: "deny" }]
    expect(
      (await decide(restricted, { agent_id: "a1", tool_name: "Bash", tool_input: { command: "ls" } }))
        ?.permissionDecision,
    ).toBe("deny")
  })

  test("subagentDecision combines resources: any deny, all allow, else ask", () => {
    const rules: Permission.Ruleset = [
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "secret/*", effect: "ask" },
    ]
    expect(SdkPermission.subagentDecision(rules, "read", ["a.ts", "b.ts"])).toBe("allow")
    expect(SdkPermission.subagentDecision(rules, "read", ["a.ts", ".env"])).toBe("deny")
    expect(SdkPermission.subagentDecision(rules, "read", ["a.ts", "secret/key"])).toBe("ask")
  })
})
