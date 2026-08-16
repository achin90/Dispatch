import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTuiPaths } from "./runtime"
import path from "path"


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
    const paths = useTuiPaths()
    void Global.Path.state
    const file = path.join(paths.state, "kv.json")
    const lock = `tui-kv:${file}`
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    Flock.withLock(lock, () => readJson<Record<string, unknown>>(file))
      .then((x) => {
        setStore(x)
        const agents = x["agents"]
      })
      .catch((error) => {
        console.error("Failed to read KV state", { file, error })
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
        if (typeof value === "function") value = value(store[key])
        setStore(key, value)
        const clonedValue = structuredClone(value)
        // Read-merge-write under the shared lock: kv.json is shared across
        // processes (agents run in their own opencode processes), so writing a
        // whole-store snapshot would clobber keys written by other processes.
        write = _pendingWrite = write
          .then(() =>
            Flock.withLock(lock, () =>
              readJson<Record<string, any>>(file)
                .catch((): Record<string, any> => ({}))
                .then((disk) => {
                  disk[key] = clonedValue
                  return writeJsonAtomic(file, disk)
                }),
            ),
          )
          .catch((error) => {
            console.error("Failed to write KV state", { file, error })
          })
      },
    }
    return result
  },
})
