import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import os from "os"
import fs from "fs/promises"
import path from "path"
import { execFile } from "child_process"
import { ProviderID, ModelID } from "../../provider/schema"
import { ToolRegistry } from "../../tool/registry"
import { Worktree } from "../../worktree"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { MCP } from "../../mcp"
import { Session } from "../../session"
import { zodToJsonSchema } from "zod-to-json-schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { WorkspaceRoutes } from "./workspace"

export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .get(
      "/git-repos",
      describeRoute({
        summary: "List git repositories",
        description:
          "Scan immediate children of a root directory and return those that are git repositories.",
        operationId: "gitRepos.list",
        responses: {
          200: {
            description: "Git repository paths",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "GitRepoPaths" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          root: z.string().optional().meta({ description: "Root directory to scan (defaults to home)" }),
          query: z.string().optional().meta({ description: "Filter repo names (case-insensitive substring)" }),
        }),
      ),
      async (c) => {
        const { root, query } = c.req.valid("query")
        const rootDir = root || os.homedir()
        const repos: string[] = []
        const needle = query?.toLowerCase()

        async function walk(dir: string) {
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
          if (!entries) return
          if (entries.some((e) => e.name === ".git")) {
            if (!needle || path.basename(dir).toLowerCase().includes(needle)) {
              repos.push(dir)
            }
            return
          }
          await Promise.all(
            entries
              .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.isSymbolicLink() && e.name !== "node_modules")
              .map((e) => walk(path.join(dir, e.name))),
          )
        }

        await walk(rootDir)
        repos.sort()
        return c.json(repos)
      },
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        return c.json(await ToolRegistry.ids())
      },
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await ToolRegistry.tools({ providerID: ProviderID.make(provider), modelID: ModelID.make(model) })
        return c.json(
          tools.map((t) => ({
            id: t.id,
            description: t.description,
            // Handle both Zod schemas and plain JSON schemas
            parameters: (t.parameters as any)?._def ? zodToJsonSchema(t.parameters as any) : t.parameters,
          })),
        )
      },
    )
    .route("/workspace", WorkspaceRoutes())
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.CreateInput.optional()),
      async (c) => {
        const body = c.req.valid("json")
        const worktree = await Worktree.create(body)
        return c.json(worktree)
      },
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktree directories",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) => {
        const sandboxes = await Project.sandboxes(Instance.project.id)
        return c.json(sandboxes)
      },
    )
    .get(
      "/worktree/info",
      describeRoute({
        summary: "Get worktree info",
        description:
          "Check if the current directory is a git worktree and return its info. Returns null if not a worktree.",
        operationId: "worktree.info",
        responses: {
          200: {
            description: "Worktree info or null",
            content: {
              "application/json": {
                schema: resolver(
                  Worktree.Info.extend({ sourceRepo: z.string() }).nullable().meta({ ref: "WorktreeDetectInfo" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory.replace(/\/+$/, "")
        const gitpath = path.join(dir, ".git")
        const content = await fs.readFile(gitpath, "utf-8").catch(() => null)
        if (!content?.startsWith("gitdir:")) return c.json(null)
        const gitdir = content.replace("gitdir:", "").trim()
        const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir)
        const head = await fs.readFile(path.join(resolved, "HEAD"), "utf-8").catch(() => "")
        const branch = head.startsWith("ref:") ? head.replace("ref:", "").trim().replace(/^refs\/heads\//, "") : path.basename(dir)
        // Derive source repo: gitdir is like /path/to/main/.git/worktrees/name
        const match = resolved.match(/^(.+)\/\.git\/worktrees\//)
        const source = match ? match[1] : path.dirname(resolved)
        return c.json({
          name: path.basename(dir),
          branch,
          directory: dir,
          sourceRepo: source,
        })
      },
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.RemoveInput),
      async (c) => {
        const body = c.req.valid("json")
        await Worktree.remove(body)
        await Project.removeSandbox(Instance.project.id, body.directory)
        return c.json(true)
      },
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.ResetInput),
      async (c) => {
        const body = c.req.valid("json")
        await Worktree.reset(body)
        return c.json(true)
      },
    )
    .get(
      "/worktree/diffstat",
      describeRoute({
        summary: "Get worktree diff stats",
        description:
          "Return line-level diff statistics (additions, deletions, file count) for uncommitted changes in the current directory.",
        operationId: "worktree.diffstat",
        responses: {
          200: {
            description: "Diff statistics",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      additions: z.number(),
                      deletions: z.number(),
                      files: z.number(),
                    })
                    .meta({ ref: "DiffStat" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        function numstat(args: string[]): Promise<string> {
          return new Promise((resolve) => {
            execFile("git", args, { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
              resolve(err ? "" : stdout)
            })
          })
        }
        const raw = await numstat(["diff", "HEAD", "--numstat"])
        const lines = raw
          .split("\n")
          .map((line) => line.split("\t"))
          .filter((p): p is [string, string, string] => p.length >= 3)
          .filter((p) => !isNaN(parseInt(p[0], 10)) && !isNaN(parseInt(p[1], 10)))
        const additions = lines.reduce((sum, p) => sum + parseInt(p[0], 10), 0)
        const deletions = lines.reduce((sum, p) => sum + parseInt(p[1], 10), 0)
        const files = new Set(lines.map((p) => p[2])).size
        return c.json({ additions, deletions, files })
      },
    )
    .get(
      "/worktree/diff",
      describeRoute({
        summary: "Get worktree diff",
        description:
          "Return the full unified diff of uncommitted changes against HEAD in the working directory.",
        operationId: "worktree.diff",
        responses: {
          200: {
            description: "Unified diff output",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      diff: z.string(),
                    })
                    .meta({ ref: "WorktreeDiff" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const diff = await new Promise<string>((resolve) => {
          execFile(
            "git",
            ["diff", "HEAD"],
            { cwd: Instance.directory, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout) => resolve(err ? "" : stdout),
          )
        })
        return c.json({ diff })
      },
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          cursor: z.coerce
            .number()
            .optional()
            .meta({ description: "Return sessions updated before this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: z.coerce.boolean().optional().meta({ description: "Include archived sessions (default false)" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor: query.cursor,
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("x-next-cursor", String(list[list.length - 1].time.updated))
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.resources())
      },
    ),
)
