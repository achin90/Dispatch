import * as Log from "@opencode-ai/core/util/log"
import { Wildcard } from "@/util/wildcard"

const log = Log.create({ service: "permission.evaluate" })

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const relevant = rules.filter((rule) => Wildcard.match(permission, rule.permission))
  log.info("evaluate", {
    permission,
    pattern,
    relevantRules: relevant.map((r) => `${r.permission}:${r.pattern}=${r.action}`),
  })
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  log.info("evaluate result", {
    permission,
    pattern,
    matchedRule: match ? `${match.permission}:${match.pattern}=${match.action}` : "none (default ask)",
  })
  return match ?? { action: "ask", permission, pattern: "*" }
}
