import { describe, test, expect } from "bun:test"
import {
  extractPatterns,
  derivePermissionName,
  createCanUseToolBridge,
  trimDiff,
} from "../../src/session/claude-sdk-permissions"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const sid = SessionID.make("ses_test-perms")
const mid = MessageID.make("msg_test-perms")

describe("claude-sdk permissions", () => {
  describe("extractPatterns", () => {
    test("Read tool extracts file_path", () => {
      expect(extractPatterns("Read", { file_path: "/tmp/test.ts" })).toEqual(["/tmp/test.ts"])
    })

    test("Write tool extracts file_path", () => {
      expect(extractPatterns("Write", { file_path: "/tmp/out.ts", content: "hello" })).toEqual(["/tmp/out.ts"])
    })

    test("Edit tool extracts file_path", () => {
      expect(extractPatterns("Edit", { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" })).toEqual([
        "/tmp/x.ts",
      ])
    })

    test("Bash tool extracts command", () => {
      expect(extractPatterns("Bash", { command: "npm install" })).toEqual(["npm install"])
    })

    test("Glob tool extracts pattern", () => {
      expect(extractPatterns("Glob", { pattern: "**/*.ts" })).toEqual(["**/*.ts"])
    })

    test("Grep tool extracts path when present", () => {
      expect(extractPatterns("Grep", { path: "/src", pattern: "TODO" })).toEqual(["/src"])
    })

    test("Grep tool extracts pattern when no path", () => {
      expect(extractPatterns("Grep", { pattern: "TODO" })).toEqual(["TODO"])
    })

    test("WebFetch extracts url", () => {
      expect(extractPatterns("WebFetch", { url: "https://example.com" })).toEqual(["https://example.com"])
    })

    test("WebSearch extracts query", () => {
      expect(extractPatterns("WebSearch", { query: "test query" })).toEqual(["test query"])
    })

    test("NotebookEdit extracts notebook_path", () => {
      expect(extractPatterns("NotebookEdit", { notebook_path: "/tmp/nb.ipynb" })).toEqual(["/tmp/nb.ipynb"])
    })

    test("unknown tool with file_path falls back to file_path", () => {
      expect(extractPatterns("CustomTool", { file_path: "/x" })).toEqual(["/x"])
    })

    test("unknown tool with path falls back to path", () => {
      expect(extractPatterns("CustomTool", { path: "/y" })).toEqual(["/y"])
    })

    test("unknown tool with command falls back to command", () => {
      expect(extractPatterns("CustomTool", { command: "do thing" })).toEqual(["do thing"])
    })

    test("unknown tool with no recognized fields falls back to tool name", () => {
      expect(extractPatterns("CustomTool", { foo: "bar" })).toEqual(["CustomTool"])
    })

    test("MCP tool with no recognized fields falls back to tool name", () => {
      expect(extractPatterns("mcp__github__list_issues", { repo: "test" })).toEqual([
        "mcp__github__list_issues",
      ])
    })
  })

  describe("derivePermissionName", () => {
    test("maps Read to read", () => {
      expect(derivePermissionName("Read")).toBe("read")
    })

    test("maps Write to edit", () => {
      expect(derivePermissionName("Write")).toBe("edit")
    })

    test("maps Edit to edit", () => {
      expect(derivePermissionName("Edit")).toBe("edit")
    })

    test("maps Bash to bash", () => {
      expect(derivePermissionName("Bash")).toBe("bash")
    })

    test("maps Glob to glob", () => {
      expect(derivePermissionName("Glob")).toBe("glob")
    })

    test("maps Grep to grep", () => {
      expect(derivePermissionName("Grep")).toBe("grep")
    })

    test("maps WebFetch to webfetch", () => {
      expect(derivePermissionName("WebFetch")).toBe("webfetch")
    })

    test("maps WebSearch to websearch", () => {
      expect(derivePermissionName("WebSearch")).toBe("websearch")
    })

    test("lowercases unknown tools", () => {
      expect(derivePermissionName("CustomTool")).toBe("customtool")
    })

    test("passes MCP tools through lowercased", () => {
      expect(derivePermissionName("mcp__github__list_issues")).toBe("mcp__github__list_issues")
    })
  })

  describe("trimDiff", () => {
    const unified = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      "+// new comment",
      " import { foo } from 'bar'",
      " ",
      " export default foo",
    ].join("\n")

    test("returns full diff when content lines exist", () => {
      const result = trimDiff(unified)
      expect(result).toBe(unified)
      expect(result).toContain("@@")
      expect(result).toContain("---")
      expect(result).toContain("+++")
    })

    test("returns empty string for header-only diff", () => {
      const empty = ["--- a/file.ts", "+++ b/file.ts", "@@ -1,3 +1,3 @@"].join("\n")
      expect(trimDiff(empty)).toBe("")
    })

    test("returns empty string for empty input", () => {
      expect(trimDiff("")).toBe("")
    })

    test("detects removal lines as content", () => {
      const removal = ["--- a/file.ts", "+++ b/file.ts", "@@ -1,2 +1 @@", "-removed line", " kept"].join("\n")
      expect(trimDiff(removal)).toBe(removal)
    })
  })

  describe("createCanUseToolBridge", () => {
    const defaultCallOptions = { signal: AbortSignal.any([]), toolUseID: "toolu_test" }

    async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
      await using tmp = await tmpdir({ git: true })
      return Instance.provide({ directory: tmp.path, fn })
    }

    test("resolves allow on 'once' reply via Permission.reply()", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })
        let capturedPermission: string | undefined
        let capturedPatterns: string[] | undefined
        let capturedSessionID: unknown

        // Listen for the Asked event and reply through the Permission system
        const unsubscribe = Bus.subscribe(Permission.Event.Asked, (event) => {
          capturedPermission = event.properties.permission
          capturedPatterns = event.properties.patterns
          capturedSessionID = event.properties.sessionID
          Permission.reply({
            requestID: event.properties.id,
            reply: "once",
          })
        })

        try {
          const result = await bridge("Read", { file_path: "/tmp/test.ts" }, defaultCallOptions)
          expect(result.behavior).toBe("allow")
          expect(capturedPermission).toBe("read")
          expect(capturedPatterns).toEqual(["/tmp/test.ts"])
          expect(capturedSessionID).toBe(sid)
        } finally {
          unsubscribe()
        }
      })
    })

    test("resolves allow on 'always' reply via Permission.reply()", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })

        const unsubscribe = Bus.subscribe(Permission.Event.Asked, (event) => {
          Permission.reply({
            requestID: event.properties.id,
            reply: "always",
          })
        })

        try {
          const result = await bridge("Bash", { command: "echo hi" }, defaultCallOptions)
          expect(result.behavior).toBe("allow")
        } finally {
          unsubscribe()
        }
      })
    })

    test("resolves deny on 'reject' reply via Permission.reply()", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })

        const unsubscribe = Bus.subscribe(Permission.Event.Asked, (event) => {
          Permission.reply({
            requestID: event.properties.id,
            reply: "reject",
          })
        })

        try {
          const result = await bridge("Write", { file_path: "/etc/passwd", content: "bad" }, defaultCallOptions)
          expect(result.behavior).toBe("deny")
          if (result.behavior === "deny") {
            expect(result.message).toBe("User rejected permission")
          }
        } finally {
          unsubscribe()
        }
      })
    })

    test("resolves deny when signal is already aborted", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })

        const result = await bridge(
          "Read",
          { file_path: "/tmp/x" },
          { signal: AbortSignal.abort(), toolUseID: "toolu_test" },
        )

        expect(result.behavior).toBe("deny")
        if (result.behavior === "deny") {
          expect(result.message).toBe("Request aborted")
        }
      })
    })

    test("resolves deny when signal aborts while waiting", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })
        const controller = new AbortController()

        const resultPromise = bridge(
          "Read",
          { file_path: "/tmp/x" },
          { signal: controller.signal, toolUseID: "toolu_test" },
        )

        setTimeout(() => controller.abort(), 10)

        const result = await resultPromise
        expect(result.behavior).toBe("deny")
        if (result.behavior === "deny") {
          expect(result.message).toBe("Request aborted")
        }
      })
    })

    // Regression: agent sessions run in a different directory than the TUI.
    // Permission.ask() fires in the agent's directory, but Permission.reply()
    // fires in the TUI's directory (from the HTTP route handler). The pending
    // map must be global, not per-directory, or replies silently fail.
    test("cross-directory: reply from different directory resolves 'once'", async () => {
      await using agentDir = await tmpdir({ git: true })
      await using tuiDir = await tmpdir({ git: true })

      // Bridge is created in the agent's directory (like createClaudeSdkQuery does)
      const bridge = await Instance.provide({
        directory: agentDir.path,
        fn: () => createCanUseToolBridge({ sessionID: sid, messageID: mid }),
      })

      // Bus.subscribe must run inside an Instance context (Bus state is per-directory).
      // We subscribe from the agent's directory since that's where ask() publishes.
      let capturedID: unknown
      const unsubscribe = await Instance.provide({
        directory: agentDir.path,
        fn: () => {
          return Bus.subscribe(Permission.Event.Asked, (event) => {
            capturedID = event.properties.id
            // reply() runs inside the TUI's directory — different from the agent.
            // This simulates the real flow: TUI sends HTTP request with its own
            // x-opencode-directory header, server runs Permission.reply() in that context.
            Instance.provide({
              directory: tuiDir.path,
              fn: () =>
                Permission.reply({
                  requestID: event.properties.id,
                  reply: "once",
                }),
            })
          })
        },
      })

      try {
        const result = await Instance.provide({
          directory: agentDir.path,
          fn: () => bridge("Read", { file_path: "/tmp/test.ts" }, { signal: AbortSignal.any([]), toolUseID: "toolu_cross" }),
        })
        expect(capturedID).toBeDefined()
        expect(result.behavior).toBe("allow")
      } finally {
        unsubscribe()
      }
    })

    test("cross-directory: reply from different directory resolves 'always'", async () => {
      await using agentDir = await tmpdir({ git: true })
      await using tuiDir = await tmpdir({ git: true })

      const bridge = await Instance.provide({
        directory: agentDir.path,
        fn: () => createCanUseToolBridge({ sessionID: sid, messageID: mid }),
      })

      const unsubscribe = await Instance.provide({
        directory: agentDir.path,
        fn: () => {
          return Bus.subscribe(Permission.Event.Asked, (event) => {
            Instance.provide({
              directory: tuiDir.path,
              fn: () =>
                Permission.reply({
                  requestID: event.properties.id,
                  reply: "always",
                }),
            })
          })
        },
      })

      try {
        const result = await Instance.provide({
          directory: agentDir.path,
          fn: () => bridge("Bash", { command: "echo hi" }, { signal: AbortSignal.any([]), toolUseID: "toolu_cross" }),
        })
        expect(result.behavior).toBe("allow")
      } finally {
        unsubscribe()
      }
    })

    test("cross-directory: reply from different directory resolves 'reject'", async () => {
      await using agentDir = await tmpdir({ git: true })
      await using tuiDir = await tmpdir({ git: true })

      const bridge = await Instance.provide({
        directory: agentDir.path,
        fn: () => createCanUseToolBridge({ sessionID: sid, messageID: mid }),
      })

      const unsubscribe = await Instance.provide({
        directory: agentDir.path,
        fn: () => {
          return Bus.subscribe(Permission.Event.Asked, (event) => {
            Instance.provide({
              directory: tuiDir.path,
              fn: () =>
                Permission.reply({
                  requestID: event.properties.id,
                  reply: "reject",
                }),
            })
          })
        },
      })

      try {
        const result = await Instance.provide({
          directory: agentDir.path,
          fn: () => bridge("Write", { file_path: "/etc/passwd", content: "bad" }, { signal: AbortSignal.any([]), toolUseID: "toolu_cross" }),
        })
        expect(result.behavior).toBe("deny")
        if (result.behavior === "deny") {
          expect(result.message).toBe("User rejected permission")
        }
      } finally {
        unsubscribe()
      }
    })

    test("request contains tool metadata", async () => {
      await withInstance(async () => {
        const bridge = createCanUseToolBridge({ sessionID: sid, messageID: mid })
        let capturedRequest: Permission.Request | undefined

        const unsubscribe = Bus.subscribe(Permission.Event.Asked, (event) => {
          capturedRequest = event.properties
          Permission.reply({
            requestID: event.properties.id,
            reply: "once",
          })
        })

        try {
          await bridge(
            "Bash",
            { command: "rm -rf /tmp/test" },
            { signal: AbortSignal.any([]), toolUseID: "toolu_test", title: "Claude wants to run: rm -rf /tmp/test" },
          )

          expect(capturedRequest).toBeDefined()
          expect(capturedRequest!.metadata.toolName).toBe("Bash")
          expect(capturedRequest!.metadata.title).toBe("Claude wants to run: rm -rf /tmp/test")
          expect(capturedRequest!.always).toEqual(["rm -rf /tmp/test"])
        } finally {
          unsubscribe()
        }
      })
    })
  })
})
