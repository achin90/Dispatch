import { describe, expect, test } from "bun:test"
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Form } from "@opencode/core/form"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, type Scope } from "effect"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BridgeMapping } from "../../src/bridge/mapping"
import { BridgeMirror } from "../../src/bridge/mirror"
import { DispatchBridge } from "../../src/bridge/service"
import { SdkPermission } from "../../src/runner/permission"
import { agent, pending, sessionID, setup } from "../fixture"
import { dependencies, inbound } from "./fake"

/** The real bridge service over real Session, Permission and Form services, with a fake SDK. */
function world(input: Parameters<typeof dependencies>[0] = {}) {
  const fake = dependencies(input)
  const directory = AbsolutePath.make(realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-location-"))))
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory,
      workspaceID: undefined,
      project: { id: Project.ID.global, directory, canonical: directory },
      vcs: undefined,
    }),
  )
  const bridge = makeGlobalNode({
    service: DispatchBridge.Service,
    layer: Layer.effect(DispatchBridge.Service, DispatchBridge.make(fake.deps)),
    deps: [Bus.node, Instance.node, Session.node, SessionExecution.node, SessionStore.node],
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Location.node,
      Database.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
      FileAccess.node,
      Form.node,
      Session.node,
      bridge,
    ]),
    [Location.node.replace(current)],
  )
  type R = SdkPermission.Requirements | Scope.Scope | Database.Service | Session.Service | DispatchBridge.Service
  const run = <A, E>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<A, E>)
  return { ...fake, directory, run }
}

/** A canUseTool wired like the runner: Location context for the prompt, the bridge for fan-out. */
const canUseTool = Effect.fn("test.canUseTool")(function* () {
  const services = yield* Effect.context<SdkPermission.Requirements>()
  const directory = SdkPermission.directory()
  const bridge = yield* DispatchBridge.Service
  const tool = SdkPermission.canUseTool({
    sessionID,
    agent,
    run: (effect, signal) => Effect.runPromiseWith(services)(effect, { signal }),
    directory,
    metadata: new Map(),
    remote: bridge,
  })
  return (name: string, input: Record<string, unknown>) => {
    const toolUseID = `toolu_${crypto.randomUUID()}`
    directory.register(toolUseID, { sessionID, messageID: SessionMessage.ID.create() })
    return tool(name, input, { signal: new AbortController().signal, toolUseID, requestId: "req" }) as Promise<
      PermissionResult
    >
  }
})

const waitFor = <A>(read: () => A | undefined) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = read()
      if (value !== undefined) return value
      yield* Effect.sleep(10)
    }
    return yield* Effect.die(new Error("timed out"))
  })

describe("DispatchBridge", () => {
  test("attach persists the mapping in Session.metadata and backfills history once", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [])
        const bridge = yield* DispatchBridge.Service
        const sessions = yield* Session.Service
        expect(yield* bridge.attach(sessionID)).toBe("cse_test")
        expect(bridge.list()).toEqual([sessionID])
        // A fresh session has no history; the mapping exists, without a mark yet.
        expect(BridgeMapping.read(yield* sessions.get(sessionID))).toEqual({ codeSessionID: "cse_test" })
        expect(fixture.calls.states).toEqual(["idle"])
        // Attaching again is the cached handle.
        expect(yield* bridge.attach(sessionID)).toBe("cse_test")
        expect(fixture.state.created).toBe(1)

        // A turn: the mirror sees the prompt, the frames and the end of the turn.
        const turn = bridge.turn(sessionID)
        const prompt = { id: SessionMessage.ID.create(), type: "user", text: "say hi" } as unknown as SessionMessage.Info
        yield* turn.prompted([prompt])
        yield* turn.frame({ type: "assistant" } as never)
        yield* turn.settle(false)
        expect(fixture.calls.states).toEqual(["idle", "running", "idle"])
        expect(fixture.calls.writes).toHaveLength(2)

        expect(yield* bridge.detach(sessionID)).toBe(true)
        expect(bridge.list()).toEqual([])
        expect(fixture.calls.closed).toBe(1)
        // Stopping keeps the mapping: starting again resumes the same remote conversation.
        expect(yield* bridge.attach(sessionID)).toBe("cse_test")
        expect(fixture.state.created).toBe(1)
        expect(yield* bridge.detach(sessionID, { forget: true })).toBe(true)
        expect(BridgeMapping.read(yield* sessions.get(sessionID))).toBeUndefined()
      }),
    )
  })

  test("a dead transport never fails attach or the turn hooks", async () => {
    const fixture = world({ fail: true })
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [])
        const bridge = yield* DispatchBridge.Service
        expect(yield* bridge.attach(sessionID)).toBe("cse_test")
        const turn = bridge.turn(sessionID)
        yield* turn.prompted([
          { id: SessionMessage.ID.create(), type: "user", text: "hi" } as unknown as SessionMessage.Info,
        ])
        yield* turn.frame({ type: "assistant" } as never)
        yield* turn.settle(true)
        expect(yield* bridge.detach(sessionID)).toBe(true)
      }),
    )
  })

  test("the mapping is ignored by Sessions that only inherited it", () => {
    const owner = { id: sessionID, metadata: { [BridgeMapping.KEY]: { sessionID, codeSessionID: "cse_x" } } }
    expect(BridgeMapping.read(owner)).toEqual({ codeSessionID: "cse_x" })
    expect(BridgeMapping.read({ ...owner, id: "ses_child" as typeof sessionID })).toBeUndefined()
  })

  test("a transient credential failure keeps the mapping; a rejected session forgets it", async () => {
    const transient = world({ credentials: async () => null })
    await transient.run(
      Effect.gen(function* () {
        yield* setup(transient.directory, [])
        const bridge = yield* DispatchBridge.Service
        const sessions = yield* Session.Service
        yield* BridgeMapping.write(sessionID, { codeSessionID: "cse_kept" })
        const failed = yield* bridge.attach(sessionID).pipe(Effect.flip)
        expect(failed).toBeInstanceOf(DispatchBridge.UnavailableError)
        expect(BridgeMapping.read(yield* sessions.get(sessionID))).toEqual({ codeSessionID: "cse_kept" })
      }),
    )
    const rejected = world({ credentials: async () => ({ terminal: true, reason: "request_rejected", status: 404 }) })
    await rejected.run(
      Effect.gen(function* () {
        yield* setup(rejected.directory, [])
        const bridge = yield* DispatchBridge.Service
        const sessions = yield* Session.Service
        yield* BridgeMapping.write(sessionID, { codeSessionID: "cse_stale" })
        yield* bridge.attach(sessionID).pipe(Effect.flip)
        expect(BridgeMapping.read(yield* sessions.get(sessionID))).toBeUndefined()
      }),
    )
  })

  test("a permission answered on claude.ai wins and the local prompt settles", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [{ action: "shell", resource: "*", effect: "ask" }])
        yield* (yield* DispatchBridge.Service).attach(sessionID)
        const call = yield* canUseTool()
        const decided = call("Bash", { command: "ls" })
        const request = yield* pending()
        const sent = yield* waitFor(() => fixture.calls.requests[0])
        expect(sent.request_id).toBe(request.id)
        expect(fixture.calls.states.at(-1)).toBe("requires_action")
        BridgeMirror.respond({
          type: "control_response",
          response: { subtype: "success", request_id: request.id, response: { behavior: "allow" } },
        })
        expect(yield* Effect.promise(() => decided)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
        expect(yield* (yield* Permission.Service).list()).toEqual([])
        // Answered there, so there is nothing to dismiss.
        expect(fixture.calls.cancels).toEqual([])
        expect(fixture.calls.states.at(-1)).toBe("running")
      }),
    )
  })

  test("a permission answered locally wins and claude.ai's copy is dismissed", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [{ action: "shell", resource: "*", effect: "ask" }])
        yield* (yield* DispatchBridge.Service).attach(sessionID)
        const call = yield* canUseTool()
        const decided = call("Bash", { command: "ls" })
        const request = yield* pending()
        yield* waitFor(() => fixture.calls.requests[0])
        yield* (yield* Permission.Service).reply({ requestID: request.id, reply: "once" })
        expect((yield* Effect.promise(() => decided)).behavior).toBe("allow")
        expect(fixture.calls.cancels).toEqual([request.id])
        // A late remote answer finds nothing waiting.
        expect(
          BridgeMirror.respond({
            type: "control_response",
            response: { subtype: "success", request_id: request.id, response: { behavior: "deny" } },
          }),
        ).toBe(false)
      }),
    )
  })

  test("an auto-allowed call never reaches claude.ai", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [{ action: "shell", resource: "*", effect: "allow" }])
        yield* (yield* DispatchBridge.Service).attach(sessionID)
        const call = yield* canUseTool()
        expect((yield* Effect.promise(() => call("Bash", { command: "ls" }))).behavior).toBe("allow")
        expect(fixture.calls.requests).toEqual([])
      }),
    )
  })

  test("a question answered from the phone fills the form", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [{ action: "question", resource: "*", effect: "allow" }])
        yield* (yield* DispatchBridge.Service).attach(sessionID)
        const call = yield* canUseTool()
        const decided = call("AskUserQuestion", {
          questions: [
            {
              header: "Color",
              question: "Pick a color",
              options: [{ label: "Red" }, { label: "Blue" }],
              multiSelect: false,
            },
          ],
        })
        yield* waitFor(() => (fixture.calls.states.at(-1) === "requires_action" ? true : undefined))
        const written = JSON.stringify(fixture.calls.writes.at(-1))
        expect(written).toContain("Pick a color")
        expect(written).toContain("2. **Blue**")
        yield* Effect.promise(async () => fixture.state.options?.onInboundMessage?.(inbound("2")))
        const result = yield* Effect.promise(() => decided)
        expect(result).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Pick a color": "Blue" } } })
        expect(fixture.calls.states.at(-1)).toBe("running")
        // Settled: later phone text is no longer an answer.
        expect(BridgeMirror.offerAnswer(sessionID, "1")).toBe(false)
      }),
    )
  })

  test("a deleted Session's mirror is detached", async () => {
    const fixture = world()
    await fixture.run(
      Effect.gen(function* () {
        yield* setup(fixture.directory, [])
        const bridge = yield* DispatchBridge.Service
        yield* bridge.attach(sessionID)
        yield* (yield* Session.Service).remove(sessionID)
        yield* waitFor(() => (bridge.list().length === 0 ? true : undefined))
        expect(fixture.calls.closed).toBe(1)
      }),
    )
  })
})
