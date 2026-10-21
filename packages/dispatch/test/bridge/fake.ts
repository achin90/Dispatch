import type { SDKControlRequest, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AttachBridgeSessionOptions, BridgeSessionHandle, SessionState } from "@anthropic-ai/claude-agent-sdk/bridge"
import { DispatchBridge } from "../../src/bridge/service"

/** A recording stand-in for the SDK's bridge handle. `fail` makes every call throw. */
export function transport(options: { readonly fail?: boolean } = {}) {
  const calls = {
    writes: [] as SDKMessage[],
    results: 0,
    states: [] as SessionState[],
    requests: [] as SDKControlRequest[],
    cancels: [] as string[],
    closed: 0,
  }
  const guard = <A>(value: A) => {
    if (options.fail) throw new Error("bridge transport is dead")
    return value
  }
  const handle = {
    write: (message: SDKMessage) => guard(calls.writes.push(message)),
    sendResult: () => guard(calls.results++),
    reportState: (state: SessionState) => guard(calls.states.push(state)),
    reportMetadata: () => guard(undefined),
    sendControlRequest: (request: SDKControlRequest) => guard(calls.requests.push(request)),
    sendControlCancelRequest: (requestID: string) => guard(calls.cancels.push(requestID)),
    flush: () => (options.fail ? Promise.reject(new Error("bridge transport is dead")) : Promise.resolve()),
    close: () => guard(calls.closed++),
  }
  return { calls, handle }
}

/** Fake bridge dependencies: a token, and an SDK that creates `cse_test` and attaches `handle`. */
export function dependencies(
  input: {
    readonly credentials?: Awaited<ReturnType<DispatchBridge.Dependencies["sdk"]>>["fetchRemoteCredentials"]
    readonly fail?: boolean
  } = {},
) {
  const fake = transport({ fail: input.fail })
  const state = { created: 0, options: undefined as AttachBridgeSessionOptions | undefined, titles: [] as string[] }
  const deps: DispatchBridge.Dependencies = {
    token: async () => ({ token: "token" }),
    sdk: async () => ({
      createCodeSession: async (_url, _token, title) => {
        state.created++
        state.titles.push(title)
        return "cse_test"
      },
      fetchRemoteCredentials:
        input.credentials ??
        (async () => ({ worker_jwt: "jwt", api_base_url: "https://example.invalid", expires_in: 60, worker_epoch: 1 })),
      attachBridgeSession: async (options) => {
        state.options = options
        return fake.handle as unknown as BridgeSessionHandle
      },
      isCredentialsFailure: (result): result is Extract<typeof result, { terminal: true }> =>
        typeof result === "object" && result !== null && "terminal" in result && result.terminal === true,
    }),
  }
  return { deps, calls: fake.calls, state }
}

/** A user frame as claude.ai delivers it to `onInboundMessage`. */
export function inbound(text: string) {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as SDKMessage
}
