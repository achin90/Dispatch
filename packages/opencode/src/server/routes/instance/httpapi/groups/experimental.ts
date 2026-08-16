import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

const GitRepoPaths = Schema.Array(Schema.String).annotate({ identifier: "GitRepoPaths" })
export const GitReposQuery = Schema.Struct({
  root: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
})

const GitHubStatus = Schema.Struct({
  authenticated: Schema.Boolean,
}).annotate({ identifier: "GitHubStatus" })

const GitHubPullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  url: Schema.String,
  draft: Schema.Boolean,
  base: Schema.String,
  checks: Schema.Literals(["pass", "fail", "pending", "none"]),
  review: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
}).annotate({ identifier: "GitHubPullRequest" })

const GitHubCreateError = Schema.Struct({
  error: Schema.String,
}).annotate({ identifier: "GitHubCreateError" })

export const GitHubPrQuery = Schema.Struct({
  branch: Schema.String,
  cwd: Schema.optional(Schema.String),
})

export const GitHubPrCreatePayload = Schema.Struct({
  head: Schema.String,
  base: Schema.optional(Schema.String),
  title: Schema.String,
  body: Schema.optional(Schema.String),
  cwd: Schema.String,
})

export const GitHubPrMergePayload = Schema.Struct({
  number: Schema.Number,
  cwd: Schema.optional(Schema.String),
})

const WorktreeDetectInfo = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    branch: Schema.String,
    directory: Schema.String,
    sourceRepo: Schema.String,
  }).annotate({ identifier: "WorktreeDetectInfo" }),
)

const DiffStat = Schema.Struct({
  additions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Number,
}).annotate({ identifier: "DiffStat" })

const WorktreeDiff = Schema.Struct({
  diff: Schema.String,
}).annotate({ identifier: "WorktreeDiff" })

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  gitRepos: "/experimental/git-repos",
  githubStatus: "/experimental/github/status",
  githubPr: "/experimental/github/pr",
  githubPrMerge: "/experimental/github/pr/merge",
  worktreeInfo: "/experimental/worktree/info",
  worktreeDiff: "/experimental/worktree/diff",
  worktreeDiffstat: "/experimental/worktree/diffstat",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
        HttpApiEndpoint.get("gitRepos", ExperimentalPaths.gitRepos, {
          query: GitReposQuery,
          success: described(GitRepoPaths, "Git repository paths"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "gitRepos.list",
            summary: "List git repositories",
            description: "Scan immediate children of a root directory and return those that are git repositories.",
          }),
        ),
        HttpApiEndpoint.get("githubStatus", ExperimentalPaths.githubStatus, {
          success: described(GitHubStatus, "gh CLI authentication status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "github.status",
            summary: "Get GitHub status",
            description: "Check if the gh CLI is installed and authenticated.",
          }),
        ),
        HttpApiEndpoint.get("githubPr", ExperimentalPaths.githubPr, {
          query: GitHubPrQuery,
          success: described(Schema.NullOr(GitHubPullRequest), "Pull request info or null"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "github.pr",
            summary: "Get PR for branch",
            description: "Look up the most recent GitHub pull request for a given branch name.",
          }),
        ),
        HttpApiEndpoint.post("githubPrCreate", ExperimentalPaths.githubPr, {
          payload: GitHubPrCreatePayload,
          success: described(
            Schema.Union([GitHubPullRequest, GitHubCreateError]),
            "Created pull request info or error on failure",
          ),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "github.createPr",
            summary: "Create a pull request",
            description: "Create a new GitHub pull request from the given head branch.",
          }),
        ),
        HttpApiEndpoint.post("githubPrMerge", ExperimentalPaths.githubPrMerge, {
          payload: GitHubPrMergePayload,
          success: described(Schema.Boolean, "Whether the merge succeeded"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "github.mergePr",
            summary: "Merge a pull request",
            description: "Merge a GitHub pull request by number.",
          }),
        ),
        HttpApiEndpoint.get("worktreeInfo", ExperimentalPaths.worktreeInfo, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeDetectInfo, "Worktree info or null"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.info",
            summary: "Get worktree info",
            description:
              "Check if the current directory is a git worktree and return its info. Returns null if not a worktree.",
          }),
        ),
        HttpApiEndpoint.get("worktreeDiff", ExperimentalPaths.worktreeDiff, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeDiff, "Unified diff output"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.diff",
            summary: "Get worktree diff",
            description: "Return the full unified diff of uncommitted changes against HEAD in the working directory.",
          }),
        ),
        HttpApiEndpoint.get("worktreeDiffstat", ExperimentalPaths.worktreeDiffstat, {
          query: WorkspaceRoutingQuery,
          success: described(DiffStat, "Diff statistics"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.diffstat",
            summary: "Get worktree diff stats",
            description:
              "Return line-level diff statistics (additions, deletions, file count) for uncommitted changes in the current directory.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
