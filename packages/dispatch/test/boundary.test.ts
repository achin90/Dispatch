import { expect, test } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { SessionMessage } from "@opencode/core/session/message"
import { Effect } from "effect"
import { SdkPermission } from "../src/runner/permission"
import { agent, location, pending, sessionID, setup } from "./fixture"

// The v2 analog of v1's instance-boundary test. SDK callbacks run on the CLI's control channel,
// outside any Effect fiber; they must reach the Permission service of the Session's own Location
// through the context the runner captured, not through ambient state. Losing that context showed
// up in v1 as a silently dead prompt while every other test passed.
test("a callback run outside any fiber reaches the Location's Permission service", async () => {
  const fixture = location()
  const messageID = SessionMessage.ID.create()
  const decided = await fixture.run(
    Effect.gen(function* () {
      yield* setup(fixture.directory, [{ action: "edit", resource: "*", effect: "ask" }])
      const services = yield* Effect.context<SdkPermission.Requirements>()
      const directory = SdkPermission.directory()
      directory.register("toolu_boundary", { sessionID, messageID })
      const canUseTool = SdkPermission.canUseTool({
        sessionID,
        agent,
        run: (effect, signal) => Effect.runPromiseWith(services)(effect, { signal }),
        directory,
        metadata: new Map(),
      })
      // A macrotask: nothing of the current fiber is on the stack when the SDK calls back.
      const answer = new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              canUseTool(
                "Write",
                { file_path: `${fixture.directory}/notes.txt`, content: "hi\n" },
                { signal: new AbortController().signal, toolUseID: "toolu_boundary", requestId: "req_1" },
              ),
            ),
          0,
        ),
      )
      const request = yield* pending()
      expect(request.sessionID).toBe(sessionID)
      expect(request.action).toBe("edit")
      expect(request.resources).toEqual(["notes.txt"])
      expect(request.source).toEqual({ type: "tool", messageID, id: "toolu_boundary" })
      const files = request.metadata?.files as Array<{ file: string; patch: string; status: string }>
      expect(files[0].file).toBe("notes.txt")
      expect(files[0].status).toBe("added")
      expect(files[0].patch).toContain("+hi")
      yield* (yield* Permission.Service).reply({ requestID: request.id, reply: "once" })
      return yield* Effect.promise(() => answer)
    }),
  )
  expect(decided).toEqual({
    behavior: "allow",
    updatedInput: { file_path: `${fixture.directory}/notes.txt`, content: "hi\n" },
  })
})
