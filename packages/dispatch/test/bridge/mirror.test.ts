import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { BridgeMirror } from "../../src/bridge/mirror"
import { BridgeQuestion } from "../../src/bridge/question"
import { transport } from "./fake"

const sessionID = SessionSchema.ID.make("ses_mirror_test")

const mirror = (options: { readonly fail?: boolean } = {}) => {
  const fake = transport(options)
  const marks: SessionMessage.ID[] = []
  const logs: string[] = []
  const handle = BridgeMirror.make(fake.handle, {
    sessionID,
    codeSessionID: "cse_test",
    log: (message) => logs.push(message),
    persist: (mark) => marks.push(mark),
  })
  return { handle, calls: fake.calls, marks, logs }
}

const texts = (writes: ReadonlyArray<unknown>) =>
  writes.map((write) => (write as { message: { content: Array<{ text: string }> } }).message.content[0].text)

describe("MirrorHandle", () => {
  test("user() writes each local prompt once, with a uuid", () => {
    const { handle, calls } = mirror()
    const prompt = { id: SessionMessage.ID.create(), text: "hello" }
    handle.user([prompt])
    // A retried attempt of the same turn mirrors its prompts again.
    handle.user([prompt])
    expect(texts(calls.writes)).toEqual(["hello"])
    expect(typeof (calls.writes[0] as { uuid?: unknown }).uuid).toBe("string")
  })

  test("user() never echoes prompts typed on claude.ai or already backfilled", () => {
    const { handle, calls } = mirror()
    const remote = SessionMessage.ID.create()
    const backfilled = SessionMessage.ID.create()
    handle.remote(remote)
    handle.covered([backfilled])
    handle.user([
      { id: remote, text: "from the phone" },
      { id: backfilled, text: "already there" },
      { id: SessionMessage.ID.create(), text: "local" },
    ])
    expect(texts(calls.writes)).toEqual(["local"])
  })

  test("result() ends the turn every time and persists a new mark once", () => {
    const { handle, calls, marks } = mirror()
    const mark = SessionMessage.ID.create()
    handle.result(mark)
    handle.result(mark)
    handle.result()
    expect(calls.results).toBe(3)
    expect(marks).toEqual([mark])
  })

  test("a dead transport never throws into the turn", async () => {
    const { handle, logs, marks } = mirror({ fail: true })
    const mark = SessionMessage.ID.create()
    expect(() => {
      handle.write(BridgeMirror.userFrame("x"))
      handle.user([{ id: SessionMessage.ID.create(), text: "x" }])
      handle.state("running")
      handle.result(mark)
      handle.cancelPermission("per_missing")
    }).not.toThrow()
    await handle.flush()
    await handle.close()
    // The mark still advances: the local transcript is authoritative, not the transport.
    expect(marks).toEqual([mark])
    expect(logs.length).toBeGreaterThan(0)
  })

  test("a remote permission answer resolves once; later answers are refused", async () => {
    const { handle, calls } = mirror()
    const answer = handle.askPermission({
      type: "control_request",
      request_id: "per_remote",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "toolu_1" },
    })
    expect(calls.requests.map((request) => request.request_id)).toEqual(["per_remote"])
    const response = (behavior: string) =>
      ({
        type: "control_response",
        response: { subtype: "success", request_id: "per_remote", response: { behavior } },
      }) as const
    expect(BridgeMirror.respond(response("allow"))).toBe(true)
    expect(await answer).toEqual({ behavior: "allow" })
    expect(BridgeMirror.respond(response("deny"))).toBe(false)
    // Already answered there: nothing left to dismiss.
    handle.cancelPermission("per_remote")
    expect(calls.cancels).toEqual([])
  })

  test("cancelPermission dismisses a prompt claude.ai still shows", () => {
    const { handle, calls } = mirror()
    void handle.askPermission({
      type: "control_request",
      request_id: "per_local",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "toolu_2" },
    })
    handle.cancelPermission("per_local")
    handle.cancelPermission("per_local")
    expect(calls.cancels).toEqual(["per_local"])
    expect(
      BridgeMirror.respond({
        type: "control_response",
        response: { subtype: "success", request_id: "per_local", response: { behavior: "allow" } },
      }),
    ).toBe(false)
  })
})

describe("remote questions", () => {
  const prompts = [
    {
      header: "Color",
      question: "Pick a color",
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "calm" },
      ],
      multiple: false,
    },
    {
      header: "Tags",
      question: "Pick tags",
      options: [
        { label: "a", description: "" },
        { label: "b", description: "" },
      ],
      multiple: true,
    },
  ]

  test("matches labels, numbers and free text", () => {
    expect(BridgeQuestion.match(prompts[0], " blue ")).toBe("Blue")
    expect(BridgeQuestion.match(prompts[0], "1")).toBe("Red")
    expect(BridgeQuestion.match(prompts[0], "green")).toBe("green")
    expect(BridgeQuestion.match(prompts[0], "  ")).toBeUndefined()
    expect(BridgeQuestion.match(prompts[1], "1, b, c")).toEqual(["a", "b", "c"])
  })

  test("answers a multi-question form in order, then replies once", () => {
    const asked: number[] = []
    const replies: unknown[] = []
    const answer = BridgeQuestion.answerer(prompts, {
      ask: (at) => asked.push(at),
      reply: (value) => replies.push(value),
    })
    expect(answer("2")).toBe(true)
    expect(asked).toEqual([1])
    expect(replies).toEqual([])
    expect(answer("a,b")).toBe(true)
    expect(replies).toEqual([{ q0: "Blue", q1: ["a", "b"] }])
    // The form is answered; later text is a prompt again.
    expect(answer("more")).toBe(false)
  })

  test("offerAnswer consults pending questions until they unregister", () => {
    const seen: string[] = []
    const unregister = BridgeMirror.registerRemoteQuestion(sessionID, (text) => {
      seen.push(text)
      return text === "yes"
    })
    expect(BridgeMirror.offerAnswer(sessionID, "no")).toBe(false)
    expect(BridgeMirror.offerAnswer(sessionID, "yes")).toBe(true)
    unregister()
    expect(BridgeMirror.offerAnswer(sessionID, "yes")).toBe(false)
    expect(seen).toEqual(["no", "yes"])
  })
})
