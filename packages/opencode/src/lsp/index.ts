import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceContext } from "@/effect/instance-context"
import { runPromiseInstance } from "@/effect/runtime"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { Flag } from "@/flag/flag"
import { Process } from "../util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, ServiceMap } from "effect"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
      // If experimental flag is enabled, disable pyright
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      // If experimental flag is disabled, disable ty
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<Status[]>
    readonly hasClients: (file: string) => Effect.Effect<boolean>
    readonly touchFile: (input: string, waitForDiagnostics?: boolean) => Effect.Effect<void>
    readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
    readonly hover: (input: { file: string; line: number; character: number }) => Effect.Effect<any>
    readonly workspaceSymbol: (query: string) => Effect.Effect<LSP.Symbol[]>
    readonly documentSymbol: (uri: string) => Effect.Effect<(LSP.DocumentSymbol | LSP.Symbol)[]>
    readonly definition: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
    readonly references: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
    readonly implementation: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
    readonly prepareCallHierarchy: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
    readonly incomingCalls: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
    readonly outgoingCalls: (input: { file: string; line: number; character: number }) => Effect.Effect<any[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LSP") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const instance = yield* InstanceContext
      const directory = instance.directory

      const clients: LSPClient.Info[] = []
      const servers: Record<string, LSPServer.Info> = {}
      const broken = new Set<string>()
      const spawning = new Map<string, Promise<LSPClient.Info | undefined>>()

      // Load server configs
      yield* Effect.promise(async () => {
        const cfg = await Config.get()

        if (cfg.lsp === false) {
          log.info("all LSPs are disabled")
          return
        }

        for (const server of Object.values(LSPServer)) {
          servers[server.id] = server
        }

        filterExperimentalServers(servers)

        for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
          const existing = servers[name]
          if (item.disabled) {
            log.info(`LSP server ${name} is disabled`)
            delete servers[name]
            continue
          }
          servers[name] = {
            ...existing,
            id: name,
            root: existing?.root ?? (async () => directory),
            extensions: item.extensions ?? existing?.extensions ?? [],
            spawn: async (root) => {
              return {
                process: lspspawn(item.command[0], item.command.slice(1), {
                  cwd: root,
                  env: {
                    ...process.env,
                    ...item.env,
                  },
                }),
                initialization: item.initialization,
              }
            },
          }
        }

        log.info("enabled LSP servers", {
          serverIds: Object.values(servers)
            .map((server) => server.id)
            .join(", "),
        })
      })

      // Cleanup: shut down all LSP clients when the scope is closed
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all(clients.map((client) => client.shutdown()))
        }),
      )

      async function getClientsForFile(file: string) {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root)
            .then((value) => {
              if (!value) broken.add(key)
              return value
            })
            .catch((err) => {
              broken.add(key)
              log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
              return undefined
            })

          if (!handle) return undefined
          log.info("spawned lsp server", { serverID: server.id })

          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
          }).catch(async (err) => {
            broken.add(key)
            await Process.stop(handle.process)
            log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
            return undefined
          })

          if (!client) {
            return undefined
          }

          const existing = clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          clients.push(client)
          return client
        }

        for (const server of Object.values(servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file)
          if (!root) continue
          if (broken.has(root + server.id)) continue

          const match = clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          spawning.set(root + server.id, task)

          task.finally(() => {
            if (spawning.get(root + server.id) === task) {
              spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          Bus.publish(Event.Updated, {})
        }

        return result
      }

      async function runAllClients<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
        const tasks = clients.map((x) => input(x))
        return Promise.all(tasks)
      }

      async function runForFile<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
        const matched = await getClientsForFile(file)
        const tasks = matched.map((x) => input(x))
        return Promise.all(tasks)
      }

      const init = Effect.fn("LSP.init")(function* () {
        // State is initialized in the layer body above; this is a no-op now
      })

      const status = Effect.fn("LSP.status")(function* () {
        const result: Status[] = []
        for (const client of clients) {
          result.push({
            id: client.serverID,
            name: servers[client.serverID].id,
            root: path.relative(directory, client.root),
            status: "connected",
          })
        }
        return result
      })

      const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
        return yield* Effect.promise(async () => {
          const extension = path.parse(file).ext || file
          for (const server of Object.values(servers)) {
            if (server.extensions.length && !server.extensions.includes(extension)) continue
            const root = await server.root(file)
            if (!root) continue
            if (broken.has(root + server.id)) continue
            return true
          }
          return false
        })
      })

      const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, waitForDiagnostics?: boolean) {
        yield* Effect.promise(async () => {
          log.info("touching file", { file: input })
          const matched = await getClientsForFile(input)
          await Promise.all(
            matched.map(async (client) => {
              const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
              await client.notify.open({ path: input })
              return wait
            }),
          ).catch((err) => {
            log.error("failed to touch file", { err, file: input })
          })
        })
      })

      const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
        return yield* Effect.promise(async () => {
          const results: Record<string, LSPClient.Diagnostic[]> = {}
          for (const result of await runAllClients(async (client) => client.diagnostics)) {
            for (const [path, diagnostics] of result.entries()) {
              const arr = results[path] || []
              arr.push(...diagnostics)
              results[path] = arr
            }
          }
          return results
        })
      })

      const hover = Effect.fn("LSP.hover")(function* (input: { file: string; line: number; character: number }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, (client) => {
            return client.connection
              .sendRequest("textDocument/hover", {
                textDocument: {
                  uri: pathToFileURL(input.file).href,
                },
                position: {
                  line: input.line,
                  character: input.character,
                },
              })
              .catch(() => null)
          })
        })
      })

      const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
        return yield* Effect.promise(async () => {
          return runAllClients((client) =>
            client.connection
              .sendRequest("workspace/symbol", {
                query,
              })
              .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
              .then((result: any) => result.slice(0, 10))
              .catch(() => []),
          ).then((result) => result.flat() as LSP.Symbol[])
        })
      })

      const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
        return yield* Effect.promise(async () => {
          const file = fileURLToPath(uri)
          return runForFile(file, (client) =>
            client.connection
              .sendRequest("textDocument/documentSymbol", {
                textDocument: {
                  uri,
                },
              })
              .catch(() => []),
          )
            .then((result) => result.flat() as (LSP.DocumentSymbol | LSP.Symbol)[])
            .then((result) => result.filter(Boolean))
        })
      })

      const definition = Effect.fn("LSP.definition")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, (client) =>
            client.connection
              .sendRequest("textDocument/definition", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
              })
              .catch(() => null),
          ).then((result) => result.flat().filter(Boolean))
        })
      })

      const references = Effect.fn("LSP.references")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, (client) =>
            client.connection
              .sendRequest("textDocument/references", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
                context: { includeDeclaration: true },
              })
              .catch(() => []),
          ).then((result) => result.flat().filter(Boolean))
        })
      })

      const implementation = Effect.fn("LSP.implementation")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, (client) =>
            client.connection
              .sendRequest("textDocument/implementation", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
              })
              .catch(() => null),
          ).then((result) => result.flat().filter(Boolean))
        })
      })

      const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, (client) =>
            client.connection
              .sendRequest("textDocument/prepareCallHierarchy", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
              })
              .catch(() => []),
          ).then((result) => result.flat().filter(Boolean))
        })
      })

      const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, async (client) => {
            const items = (await client.connection
              .sendRequest("textDocument/prepareCallHierarchy", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
              })
              .catch(() => [])) as any[]
            if (!items?.length) return []
            return client.connection
              .sendRequest("callHierarchy/incomingCalls", { item: items[0] })
              .catch(() => [])
          }).then((result) => result.flat().filter(Boolean))
        })
      })

      const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: {
        file: string
        line: number
        character: number
      }) {
        return yield* Effect.promise(async () => {
          return runForFile(input.file, async (client) => {
            const items = (await client.connection
              .sendRequest("textDocument/prepareCallHierarchy", {
                textDocument: { uri: pathToFileURL(input.file).href },
                position: { line: input.line, character: input.character },
              })
              .catch(() => [])) as any[]
            if (!items?.length) return []
            return client.connection
              .sendRequest("callHierarchy/outgoingCalls", { item: items[0] })
              .catch(() => [])
          }).then((result) => result.flat().filter(Boolean))
        })
      })

      log.info("init")
      return Service.of({
        init,
        status,
        hasClients,
        touchFile,
        diagnostics,
        hover,
        workspaceSymbol,
        documentSymbol,
        definition,
        references,
        implementation,
        prepareCallHierarchy,
        incomingCalls,
        outgoingCalls,
      })
    }),
  )

  // Async facades
  export async function init() {
    return runPromiseInstance(Service.use((svc) => svc.init()))
  }

  export async function status() {
    return runPromiseInstance(Service.use((svc) => svc.status()))
  }

  export async function hasClients(file: string) {
    return runPromiseInstance(Service.use((svc) => svc.hasClients(file)))
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    return runPromiseInstance(Service.use((svc) => svc.touchFile(input, waitForDiagnostics)))
  }

  export async function diagnostics() {
    return runPromiseInstance(Service.use((svc) => svc.diagnostics()))
  }

  export async function hover(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.hover(input)))
  }

  export async function workspaceSymbol(query: string) {
    return runPromiseInstance(Service.use((svc) => svc.workspaceSymbol(query)))
  }

  export async function documentSymbol(uri: string) {
    return runPromiseInstance(Service.use((svc) => svc.documentSymbol(uri)))
  }

  export async function definition(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.definition(input)))
  }

  export async function references(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.references(input)))
  }

  export async function implementation(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.implementation(input)))
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.prepareCallHierarchy(input)))
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.incomingCalls(input)))
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }) {
    return runPromiseInstance(Service.use((svc) => svc.outgoingCalls(input)))
  }

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
