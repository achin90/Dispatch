export * as DispatchRpcNode from "./node.js"

import { LLMClient, Message } from "@opencode/ai"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Instance } from "@opencode/core/instance/service"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Rpc } from "@opencode/core/rpc"
import { SessionContext } from "@opencode/core/session/context"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { SdkEnv } from "../sdk/env.js"
import { SdkModels } from "../sdk/models.js"
import { DispatchRpc } from "./definition.js"
import { DispatchGit } from "./git.js"
import { DispatchGitHub } from "./github.js"
import { DispatchLastResponse } from "./last-response.js"

/**
 * Registers the `dispatch` RPC in every Location. It is a location node rather than a `define()`
 * plugin because `mcp.health` and `session.lastResponse` need core services, which host plugins
 * do not receive. Handlers close over the services captured here and require nothing themselves.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const location = yield* Location.Service
    const mcp = yield* Mcp.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const llm = yield* LLMClient.Service
    const integrations = yield* Integration.Service
    const database = yield* Database.Service
    const global = yield* Global.Service
    const importLegacy = V1Migration.importMissing().pipe(
      Effect.provideService(Database.Service, database),
      Effect.provideService(Global.Service, global),
    )

    /** The Session's small (title) model, resolved at the Session's own Location. */
    const small = (session: SessionSchema.Info, input: string) =>
      Effect.gen(function* () {
        const context = yield* SessionContext.Service
        const selection = yield* context.selectTitle(session)
        if (!selection) return undefined
        const prepared = yield* context.request.title({
          session,
          agent: selection.agent.id,
          model: selection.selected,
          system: [],
          messages: [Message.user(input)],
        })
        return (yield* llm.generate(prepared.request, prepared.options)).text
      }).pipe(instances.provide(session), Effect.timeout(DispatchLastResponse.SUMMARY_TIMEOUT))

    const lastResponse = Effect.fn("DispatchRpc.lastResponse")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return { text: "", summary: false }
      // The store defaults to newest first; lastText expects chronological order.
      const messages = yield* store.messages({ sessionID, order: "asc" }).pipe(Effect.orElseSucceed(() => []))
      const found = DispatchLastResponse.lastText(messages)
      const model = found.last?.type === "assistant" ? found.last.model : undefined
      return yield* DispatchLastResponse.respond(found.text, (input) =>
        model && SdkModels.isSdkModel(model)
          ? SdkEnv.apiKey(integrations).pipe(Effect.flatMap((key) => DispatchLastResponse.anthropic(input, key)))
          : small(session, input),
      )
    })

    const directory = (input: { readonly directory?: string } | undefined) => input?.directory ?? location.directory

    yield* rpc
      .register(DispatchRpc.Definition, {
        "gitRepos.list": (input) => DispatchGit.repos(input ?? {}),
        "github.status": () => DispatchGitHub.status(),
        "github.pr": (input) => DispatchGitHub.pr(input.branch, input.cwd ?? location.directory),
        "github.createPr": (input) => DispatchGitHub.create(input, input.cwd ?? location.directory),
        "github.mergePr": (input) => DispatchGitHub.merge(input.number, input.cwd ?? location.directory),
        "worktree.info": (input) => DispatchGit.worktree(directory(input)),
        "worktree.diff": (input) => DispatchGit.diff(directory(input)),
        "worktree.diffstat": (input) => DispatchGit.diffstat(directory(input)),
        "session.lastResponse": (input) => lastResponse(SessionSchema.ID.make(input.sessionID)),
        "mcp.health": () =>
          mcp.health().pipe(
            Effect.tap((results) =>
              Effect.logInfo("mcp health check", {
                unhealthy: results.filter((result) => !result.healthy).map((result) => result.server),
              }),
            ),
            Effect.as(true),
          ),
        "migration.sync": () => importLegacy,
      })
      .pipe(Effect.orDie)
    // A V1 client may share this database; pick up what it wrote while this server was down.
    yield* importLegacy.pipe(Effect.forkScoped)
  }),
)

export const node = makeLocationNode({
  name: "dispatch-rpc",
  layer,
  deps: [
    Rpc.node,
    Location.node,
    Mcp.node,
    SessionStore.node,
    Instance.node,
    llmClient,
    Integration.node,
    Database.node,
    Global.node,
  ],
})
