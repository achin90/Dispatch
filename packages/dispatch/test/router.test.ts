import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import type { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import type { Tool } from "@opencode/core/tool"
import { Provider } from "@opencode/schema/provider"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { SdkPermission } from "../src/runner/permission"
import { SdkRouter } from "../src/runner/router"
import * as sdk from "./sdk"

const sessionID = SessionSchema.ID.make("ses_router_test")
const childID = SessionSchema.ID.make("ses_router_child")
const agent = Agent.ID.make("build")
const model = Model.Ref.make({ providerID: Provider.ID.anthropic, id: Model.ID.make("opus-5-5") })

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node]),
  [],
)

const insertSession = (id: SessionSchema.ID, parent?: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        ...(parent ? { parent_id: parent } : {}),
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent,
      })
      .run()
      .pipe(Effect.orDie)
  })

/** Routes frames through a real Bus and projector, then reads the projected Session messages. */
const route = (
  frames: SDKMessage[],
  options: { readonly summary?: string; readonly metadata?: Map<string, Tool.Metadata> } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* insertSession(sessionID)
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const database = yield* Database.Service
      const children: string[] = []
      const inits: string[] = []
      const router = SdkRouter.make({
        bus,
        sessionID,
        agent,
        model,
        cost: [],
        directory: SdkPermission.directory(),
        metadata: options.metadata ?? new Map(),
        createChild: (input) =>
          insertSession(childID, sessionID).pipe(
            Effect.provideService(Database.Service, database),
            Effect.map(() => {
              children.push(input.title)
              return { sessionID: childID, agent }
            }),
          ),
        onInit: (uuid) => Effect.sync(() => void inits.push(uuid)),
        compactSummary: () => options.summary,
      })
      for (const frame of frames) yield* router.handle(frame)
      const read = (id: SessionSchema.ID) =>
        store.context(id).pipe(Effect.map((messages) => messages.filter((message) => message.type !== "user")))
      return {
        router,
        children,
        inits,
        main: yield* read(sessionID),
        child: children.length > 0 ? yield* read(childID) : [],
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

const assistants = (messages: readonly SessionMessage.Info[]) =>
  messages.filter((message): message is SessionMessage.Assistant => message.type === "assistant")

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }

describe("SDK frames → v2 messages", () => {
  test("one assistant message per API call, tools provider-executed with their SDK result", async () => {
    const out = await route([
      sdk.system("init", { session_id: "uuid-1" }),
      ...sdk.toolTurn("msg_1", { id: "toolu_1", name: "Bash", input: { command: "ls", timeout: 5 } }, usage),
      sdk.toolResult("toolu_1", [{ type: "text", text: "a.txt\nb.txt" }]),
      ...sdk.textTurn("msg_2", "There are 2 files.", { ...usage, output_tokens: 7 }),
      sdk.result(),
    ])
    expect(out.inits).toEqual(["uuid-1"])
    const [first, second] = assistants(out.main)
    expect(first.finish).toBe("tool-calls")
    const tool = first.content.find((part) => part.type === "tool")
    expect(tool).toMatchObject({ name: "shell", executed: true })
    expect(tool?.state).toMatchObject({
      status: "completed",
      input: { command: "ls" },
      content: [{ type: "text", text: "a.txt\nb.txt" }],
    })
    expect(second.finish).toBe("stop")
    expect(second.content).toEqual([{ type: "text", text: "There are 2 files." }])
  })

  test("tokens are each call's own usage, set once, never the result totals or a sum of frames", async () => {
    const out = await route([
      ...sdk.textTurn("msg_1", "one", usage),
      // A second usage frame for the same call replaces, it does not add.
      sdk.messageDelta("end_turn", { output_tokens: 25 }),
      ...sdk.textTurn("msg_2", "two", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 500 }),
      sdk.result(),
    ])
    const [first, second] = assistants(out.main)
    expect(first.tokens).toEqual({ input: 10, output: 25, reasoning: 0, cache: { read: 300, write: 40 } })
    expect(second.tokens).toEqual({ input: 1, output: 2, reasoning: 0, cache: { read: 500, write: 0 } })
  })

  test("complete frames publish when a call was not streamed; empty thinking is dropped", async () => {
    const out = await route([
      sdk.assistant("msg_1", [{ type: "thinking", thinking: "", signature: "s" }], usage),
      sdk.assistant("msg_1", [{ type: "thinking", thinking: "weighing options", signature: "s" }], usage),
      sdk.assistant("msg_1", [{ type: "text", text: "Reading the file." }], usage),
      sdk.assistant(
        "msg_1",
        [{ type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/p/a.ts", limit: 5 } }],
        usage,
      ),
      sdk.toolResult("toolu_r", "export const a = 1"),
      sdk.result(),
    ])
    const [message] = assistants(out.main)
    expect(message.content.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])
    expect(message.content[0]).toMatchObject({ type: "reasoning", text: "weighing options" })
    expect(message.content[2]).toMatchObject({
      name: "read",
      state: { status: "completed", input: { path: "/p/a.ts", limit: 5 } },
    })
  })

  test("streamed thinking becomes reasoning with its text", async () => {
    const out = await route([
      sdk.messageStart("msg_1", usage),
      sdk.blockStart(0, { type: "thinking", thinking: "" }),
      sdk.thinkingDelta(0, "plan "),
      sdk.thinkingDelta(0, "first"),
      sdk.blockStop(0),
      sdk.blockStart(1, { type: "thinking", thinking: "" }),
      sdk.blockStop(1),
      sdk.blockStart(2, { type: "text", text: "" }),
      sdk.textDelta(2, "Done."),
      sdk.blockStop(2),
      sdk.assistant("msg_1", [{ type: "text", text: "Done." }], usage),
      sdk.messageDelta("end_turn", { output_tokens: 3 }),
      sdk.result(),
    ])
    const [message] = assistants(out.main)
    expect(message.content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "plan first" }),
      { type: "text", text: "Done." },
    ])
  })

  test("an error result marks the tool failed with the SDK's message", async () => {
    const out = await route([
      ...sdk.toolTurn("msg_1", { id: "toolu_e", name: "Edit", input: { file_path: "/p/a.ts" } }, usage),
      sdk.toolResult("toolu_e", "The user declined this tool call", true),
      ...sdk.textTurn("msg_2", "ok", usage),
      sdk.result(),
    ])
    const tool = assistants(out.main)[0].content.find((part) => part.type === "tool")
    expect(tool?.state).toMatchObject({
      status: "error",
      error: { type: "tool.execution", message: "The user declined this tool call" },
    })
  })

  test("metadata from the permission bridge (edit diffs) lands on the completed tool", async () => {
    const files = [{ file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", status: "modified", additions: 1, deletions: 1 }]
    const out = await route(
      [
        ...sdk.toolTurn("msg_1", { id: "toolu_d", name: "Edit", input: { file_path: "/p/a.ts" } }, usage),
        sdk.toolResult("toolu_d", "updated"),
        ...sdk.textTurn("msg_2", "ok", usage),
        sdk.result(),
      ],
      { metadata: new Map([["toolu_d", { files }]]) },
    )
    const tool = assistants(out.main)[0].content.find((part) => part.type === "tool")
    expect(tool).toMatchObject({ name: "edit", state: { status: "completed", metadata: { files } } })
  })

  test("advisor calls render as a tool part completed by their result block", async () => {
    const out = await route([
      sdk.assistant("msg_1", [{ type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} }], usage),
      sdk.assistant(
        "msg_1",
        [
          {
            type: "advisor_tool_result",
            tool_use_id: "srvtoolu_1",
            content: { type: "advisor_result", text: "Check the null case." },
          },
        ],
        usage,
      ),
      sdk.assistant("msg_1", [{ type: "server_tool_use", id: "srvtoolu_2", name: "advisor", input: {} }], usage),
      sdk.assistant(
        "msg_1",
        [
          {
            type: "advisor_tool_result",
            tool_use_id: "srvtoolu_2",
            content: { type: "advisor_tool_result_error", error_code: "overloaded" },
          },
        ],
        usage,
      ),
      sdk.result(),
    ])
    const tools = assistants(out.main)[0].content.filter((part) => part.type === "tool")
    expect(tools[0]).toMatchObject({
      name: "advisor",
      state: { status: "completed", content: [{ type: "text", text: "Check the null case." }] },
    })
    expect(tools[1]).toMatchObject({
      name: "advisor",
      state: { status: "error", error: { message: "Advisor unavailable (overloaded)" } },
    })
  })

  test("subagent frames go to a child Session linked from the parent's subagent tool", async () => {
    const parent = "toolu_agent"
    const out = await route([
      ...sdk.toolTurn(
        "msg_1",
        { id: parent, name: "Agent", input: { description: "find tests", prompt: "look", subagent_type: "Explore" } },
        usage,
      ),
      sdk.system("task_started", {
        task_id: "t1",
        tool_use_id: parent,
        description: "find tests",
        subagent_type: "Explore",
      }),
      ...sdk.textTurn("msg_child", "Found 3 tests.", usage, parent),
      sdk.toolResult(parent, [{ type: "text", text: "Found 3 tests." }]),
      ...sdk.textTurn("msg_2", "The subagent found 3 tests.", usage),
      sdk.result(),
    ])
    expect(out.children).toEqual(["find tests (@explore subagent)"])
    const tool = assistants(out.main)[0].content.find((part) => part.type === "tool")
    expect(tool).toMatchObject({
      name: "subagent",
      state: {
        status: "completed",
        input: { description: "find tests", prompt: "look", agent: "explore" },
        metadata: { sessionID: childID },
      },
    })
    expect(assistants(out.child)[0].content).toEqual([{ type: "text", text: "Found 3 tests." }])
  })

  test("a compaction boundary records a completed Compaction with the hook's summary", async () => {
    const out = await route(
      [
        ...sdk.textTurn("msg_1", "before", usage),
        sdk.system("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 900_000 } }),
        ...sdk.textTurn("msg_2", "after", usage),
        sdk.result(),
      ],
      { summary: "We listed files." },
    )
    const compaction = out.main.find((message) => message.type === "compaction")
    expect(compaction).toMatchObject({ status: "completed", reason: "auto", summary: "We listed files." })
  })

  test("an error result before any output publishes nothing, so a stale resume can retry silently", async () => {
    const out = await route([
      sdk.result({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["No conversation found with session ID x"],
      }),
    ])
    expect(out.main).toEqual([])
    expect(out.router.outputStarted()).toBe(false)
  })

  test("interrupting fails open tools and the message as aborted", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertSession(sessionID)
        const router = SdkRouter.make({
          bus: yield* Bus.Service,
          sessionID,
          agent,
          model,
          cost: [],
          directory: SdkPermission.directory(),
          metadata: new Map(),
          createChild: () => Effect.die("unused"),
          onInit: () => Effect.void,
          compactSummary: () => undefined,
        })
        for (const frame of sdk.toolTurn(
          "msg_1",
          { id: "toolu_i", name: "Bash", input: { command: "sleep 9" } },
          usage,
        ))
          yield* router.handle(frame)
        yield* router.abort({ type: "aborted", message: "Step interrupted" }, true)
        return yield* (yield* SessionStore.Service).context(sessionID)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    const [message] = assistants(out)
    expect(message.error).toMatchObject({ type: "aborted" })
    expect(message.content[0]).toMatchObject({ state: { status: "error", error: { type: "aborted" } } })
  })
})
