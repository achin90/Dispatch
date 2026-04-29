import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import { rename, rm } from "fs/promises"
import { createSignal, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import * as Log from "@opencode-ai/core/util/log"
import type { AgentEntry } from "../routes/home"
import path from "path"

const log = Log.create({ service: "tui-kv" })

// Module-level reference to the tail of the write queue so callers outside
// the Solid render tree (e.g. the CLI exit handler) can drain pending writes
// before calling process.exit().
let _pendingWrite: Promise<void> = Promise.resolve()

export function flushKV(): Promise<void> {
  return _pendingWrite
}

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const filePath = path.join(Global.Path.state, "kv.json")
    const lock = `tui-kv:${filePath}`
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    // Write to a temp file first so kv.json is only replaced once the JSON is complete, avoiding partial writes if shutdown interrupts persistence.
    function writeSnapshot(snapshot: Record<string, any>) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      return Filesystem.writeJson(tempPath, snapshot)
        .then(() => rename(tempPath, filePath))
        .catch(async (error) => {
          await rm(tempPath, { force: true }).catch(() => undefined)
          throw error
        })
    }

    // Read under the same lock used for writes because kv.json is shared across processes.
    Flock.withLock(lock, () => Filesystem.readJson<Record<string, any>>(filePath))
      .then((x) => {
        setStore(x)
        const agents = x["agents"]
        if (Array.isArray(agents)) {
          log.info("loaded", { count: agents.length, ids: agents.map((a: AgentEntry) => a.id).join(",") })
        } else {
          log.info("loaded", { agents: "none" })
        }
      })
      .catch((error) => {
        console.error("Failed to read KV state", { filePath, error })
        log.error("load failed", { error: String(error) })
      })
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        const snapshot = structuredClone(unwrap(store))
        if (key === "agents" && Array.isArray(value)) {
          log.info("set agents", { count: value.length, ids: value.map((a: AgentEntry) => a.id).join(",") })
        } else {
          log.info("set", { key })
        }
        write = _pendingWrite = write
          .then(() => Flock.withLock(lock, () => writeSnapshot(snapshot)))
          .then(() => {
            if (key === "agents") return log.info("written agents", { count: snapshot["agents"]?.length ?? 0 })
            log.info("written", { key })
          })
          .catch((error) => {
            console.error("Failed to write KV state", { filePath, error })
            log.error("write failed", { key, error: String(error) })
          })
      },
    }
    return result
  },
})
