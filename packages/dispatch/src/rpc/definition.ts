export * as DispatchRpc from "./definition.js"

import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"

// Portable (Standard Schema) so the promise client can type calls; this file must only import
// `effect` and `@opencode/schema` because the TUI imports it.
const portable = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Empty = portable(Schema.UndefinedOr(Schema.Struct({})))
const Directory = portable(Schema.UndefinedOr(Schema.Struct({ directory: optional(Schema.String) })))

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  url: Schema.String,
  draft: Schema.Boolean,
  base: Schema.String,
  checks: Schema.Literals(["pass", "fail", "pending", "none"]),
  review: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
})
export type PullRequest = typeof PullRequest.Type

export const CreateError = Schema.Struct({ error: Schema.String })
export type CreateError = typeof CreateError.Type

export const WorktreeInfo = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  directory: Schema.String,
  sourceRepo: Schema.String,
})
export type WorktreeInfo = typeof WorktreeInfo.Type

export const DiffStat = Schema.Struct({ files: Schema.Number, additions: Schema.Number, deletions: Schema.Number })
export type DiffStat = typeof DiffStat.Type

/**
 * Dispatch's server API (the v1 `/experimental/*` dashboard routes). Call it at
 * `POST /api/rpc/dispatch/<method>` with `{ input }`; the Location comes from `?location[directory]=`
 * or the `x-opencode-directory` header and defaults `directory`/`cwd` inputs.
 */
export const Definition = Rpc.define({
  id: "dispatch",
  methods: {
    "gitRepos.list": {
      input: portable(
        Schema.UndefinedOr(Schema.Struct({ root: optional(Schema.String), query: optional(Schema.String) })),
      ),
      output: portable(Schema.Struct({ repos: Schema.Array(Schema.String) })),
    },
    "github.status": {
      input: Empty,
      output: portable(Schema.Struct({ authenticated: Schema.Boolean })),
    },
    "github.pr": {
      input: portable(Schema.Struct({ branch: Schema.String, cwd: optional(Schema.String) })),
      output: portable(Schema.NullOr(PullRequest)),
    },
    "github.createPr": {
      input: portable(
        Schema.Struct({
          head: Schema.String,
          base: optional(Schema.String),
          title: Schema.String,
          body: optional(Schema.String),
          cwd: optional(Schema.String),
        }),
      ),
      output: portable(Schema.Union([PullRequest, CreateError])),
    },
    "github.mergePr": {
      input: portable(Schema.Struct({ number: Schema.Number, cwd: optional(Schema.String) })),
      output: portable(Schema.Boolean),
    },
    "worktree.info": { input: Directory, output: portable(Schema.NullOr(WorktreeInfo)) },
    "worktree.diff": { input: Directory, output: portable(Schema.Struct({ diff: Schema.String })) },
    "worktree.diffstat": { input: Directory, output: portable(DiffStat) },
    "session.lastResponse": {
      input: portable(Schema.Struct({ sessionID: Schema.String })),
      output: portable(Schema.Struct({ text: Schema.String, summary: Schema.Boolean })),
    },
    "mcp.health": { input: Empty, output: portable(Schema.Boolean) },
    /** Imports Sessions a V1 client wrote to the shared database since the one-time migration. */
    "migration.sync": { input: Empty, output: portable(Schema.Array(Schema.String)) },
  },
  events: {},
})
