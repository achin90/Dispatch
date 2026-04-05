import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk"
import type { SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { resolveApiKey } from "./claude-sdk-query"
import { resultMessageToMetadata } from "./claude-sdk-adapter"
import { getSdkSessionID, removeSdkSessionID } from "./claude-sdk-session-map"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const reserved =
      config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
    const usable = input.model.limit.input
      ? input.model.limit.input - reserved
      : context - ProviderTransform.maxOutputTokens(input.model)
    return count >= usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: SessionID }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    // Use the session's stored directory instead of Instance.directory.
    // The ALS context may belong to a different instance (e.g. the root
    // /Documents instance) than the project that owns this session.
    const session = await Session.get(input.sessionID)
    const cwd = session.directory

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const msgs = structuredClone(messages)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

    let result: "compact" | "continue" | "stop" | undefined

    if (model.providerID === "anthropic") {
      // ── Claude SDK path ──────────────────────────────────────────────
      // Resume the existing SDK session and send /compact. The SDK
      // compacts internally and the session is preserved (no context
      // re-inflation on the next turn). Uses OAuth/subscription auth
      // so compaction works without an explicit ANTHROPIC_API_KEY.
      const apiKey = await resolveApiKey()
      const env: Record<string, string | undefined> = { ...globalThis.process.env }
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey

      const sdkSession = await getSdkSessionID(input.sessionID)
      log.info("sdk compact", {
        sessionID: input.sessionID,
        sdkSession,
        modelID: model.id,
        modelApiID: model.api.id,
        providerID: model.providerID,
        hasApiKey: !!apiKey,
        auto: input.auto,
        overflow: input.overflow,
      })
      if (!sdkSession) {
        log.error("no sdk session to compact")
        result = "stop"
      } else {
        const ref: { summary?: string } = {}
        // Only pass custom instructions from the plugin hook, not the
        // default template — the SDK has its own summarization logic.
        const compact = compacting.prompt ? `/compact ${compacting.prompt}` : "/compact"
        log.info("sdk compact query", {
          prompt: compact,
          resume: sdkSession,
          model: model.api.id,
          cwd,
        })
        const stream = claudeQuery({
          prompt: compact,
          options: {
            model: model.api.id,
            cwd,
            env,
            resume: sdkSession,
            maxTurns: 1,
            hooks: {
              PostCompact: [
                {
                  hooks: [
                    async (input) => {
                      log.info("sdk compact PostCompact hook fired", {
                        hasSummary: !!(input as { compact_summary: string }).compact_summary,
                      })
                      ref.summary = (input as { compact_summary: string }).compact_summary
                      return { continue: true }
                    },
                  ],
                },
              ],
            },
          },
        })

        try {
          let boundary = false
          let text = ""
          const eventTypes: string[] = []
          for await (const event of stream) {
            if (input.abort.aborted) break
            const subtype = (event as { subtype?: string }).subtype
            eventTypes.push(subtype ? `${event.type}:${subtype}` : event.type)
            if (event.type === "system" && subtype === "compact_boundary") {
              boundary = true
              log.info("sdk compact boundary received", {
                compactMetadata: JSON.stringify(
                  (event as Record<string, unknown>).compact_metadata ??
                    (event as Record<string, unknown>).compactMetadata ??
                    null,
                ),
              })
            }
            if (event.type === "assistant") {
              for (const block of (event as SDKAssistantMessage).message.content) {
                if (block.type === "text") text += block.text
              }
            }
            if (event.type === "result") {
              const resultMsg = event as SDKResultMessage
              const subtype = (resultMsg as { subtype?: string }).subtype
              const errors = (resultMsg as { errors?: string[] }).errors
              log.info("sdk compact result", {
                is_error: resultMsg.is_error,
                subtype,
                errors: errors?.join("; "),
                session_id: resultMsg.session_id,
                num_turns: (resultMsg as { num_turns?: number }).num_turns,
                stop_reason: (resultMsg as { stop_reason?: string | null }).stop_reason,
                duration_ms: (resultMsg as { duration_ms?: number }).duration_ms,
              })
              const meta = resultMessageToMetadata(resultMsg)
              msg.cost = meta.total_cost_usd
              // The SDK processes /compact internally and returns zero token
              // counts. Leave tokens at zero so isOverflow treats this as
              // a fresh context; the next regular response will populate
              // the accurate post-compaction count.
              msg.tokens = {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              }
              msg.finish = meta.stop_reason ?? "end_turn"
              break
            }
          }

          log.info("sdk compact stream finished", {
            boundary,
            aborted: input.abort.aborted,
            textLength: text.length,
            hasSummaryFromHook: !!ref.summary,
            eventTypes: eventTypes.join(", "),
          })

          if (boundary) {
            const summary = ref.summary || text || "Conversation was compacted"
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              type: "text",
              text: summary,
              time: { start: Date.now(), end: Date.now() },
            })
            msg.time.completed = Date.now()
            await Session.updateMessage(msg)
            log.info("sdk compact succeeded")
            result = "continue"
          } else {
            log.error("sdk /compact did not produce compact_boundary", {
              eventTypes: eventTypes.join(", "),
              textLength: text.length,
              textPreview: text.slice(0, 300),
              aborted: input.abort.aborted,
            })
            // Clear the SDK session mapping so the next message creates a fresh session.
            // The compact_boundary not being emitted indicates the session is unusable.
            log.info("clearing sdk session mapping after compact failure", { sdkSession })
            await removeSdkSessionID(input.sessionID)
            msg.error = {
              name: "UnknownError",
              data: { message: "SDK compaction did not produce a boundary" },
            } as MessageV2.Assistant["error"]
            msg.time.completed = Date.now()
            await Session.updateMessage(msg)
            result = "stop"
          }
        } catch (e) {
          log.error("sdk compact error", {
            error: e,
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
          })
          const errMsg = e instanceof Error ? e.message : String(e)
          if (/prompt is too long|exceeds.*context/i.test(errMsg)) {
            result = "compact"
          } else {
            msg.error = {
              name: "APIError",
              data: { message: errMsg, isRetryable: false },
            } as MessageV2.Assistant["error"]
            msg.time.completed = Date.now()
            await Session.updateMessage(msg)
            result = "stop"
          }
        }
      }
    } else {
      // ── AI SDK path (non-anthropic providers) ────────────────────────
      const processor = SessionProcessor.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        abort: input.abort,
      })
      result = await processor.process({
        user: userMessage,
        agent,
        abort: input.abort,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...MessageV2.toModelMessages(msgs, model, { stripMedia: true }),
          {
            role: "user",
            content: [{ type: "text", text: promptText }],
          },
        ],
        model,
      })
    }

    if (result === "compact") {
      msg.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      msg.finish = "error"
      await Session.updateMessage(msg)
      return "stop"
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (result === "stop" || msg.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    },
  )
}
