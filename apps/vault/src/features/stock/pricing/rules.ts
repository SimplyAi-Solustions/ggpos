/**
 * Pricing Studio-lite: the maths of one sell-price rule, pure and in pence.
 *
 *   1. Start point: a % of market, cost plus a markup %, or a fixed price.
 *   2. Adjust by a whole percent (-10 is 10% off, 5 is 5% on).
 *   3. Round: charm (.99), .49/.99, or to the nearest 25p, 50p or £1.
 *   4. Safety: never below cost (lifted to the first rounded price at or
 *      above cost, "Limited"), protect hand-stickered items, and a maximum
 *      % change beyond which the change waits for approval.
 */
import { applyPercent, roundHalfUp, roundToRetailEnding, roundToStep, type RoundingStep } from "@gg/shared/money"

import type { InventoryItem } from "../types"

export type RuleStart = "market_pct" | "cost_markup" | "fixed"
export type RuleRounding = "none" | "charm_99" | "charm_49_99" | "round_to"
export type RuleMatch = "all" | "category" | "game" | "kind"

export interface SellRule {
  id?: string
  name: string
  active: boolean
  approval: "ask" | "auto"
  match: RuleMatch
  match_category: string
  match_game: string
  match_kind: string
  start: RuleStart
  /** market_pct and cost_markup: a whole percent. fixed: pence. */
  start_value: number
  adjust_pct: number
  rounding: RuleRounding
  round_step: number
  never_below_cost: boolean
  /** 0 is no limit. */
  max_change_pct: number
  protect_hand: boolean
}

export const NEW_RULE: SellRule = {
  name: "New rule",
  active: true,
  approval: "ask",
  match: "all",
  match_category: "",
  match_game: "",
  match_kind: "",
  start: "market_pct",
  start_value: 100,
  adjust_pct: 0,
  rounding: "charm_99",
  round_step: 50,
  never_below_cost: true,
  max_change_pct: 20,
  protect_hand: true,
}

export type Outcome = "update" | "limited" | "approval" | "skip"

export interface RuleResult {
  item: InventoryItem
  outcome: Outcome
  /** The price the rule wants, pence; null when it left the item alone. */
  proposed: number | null
  reason: string
}

function step(value: number): RoundingStep {
  return value === 25 || value === 100 ? value : 50
}

/** Nearest .99: £10.40 is £9.99, £10.60 is £10.99. Never under £0.99. */
export function charm99(pence: number): number {
  return Math.max(99, roundHalfUp(pence / 100) * 100 - 1)
}

export function applyRounding(pence: number, rule: Pick<SellRule, "rounding" | "round_step">): number {
  switch (rule.rounding) {
    case "charm_99":
      return charm99(pence)
    case "charm_49_99":
      return roundToRetailEnding(pence)
    case "round_to":
      return roundToStep(pence, step(rule.round_step))
    default:
      return pence
  }
}

/** The first price at or above `floor` that the rounding allows. */
export function roundUpTo(floor: number, rule: Pick<SellRule, "rounding" | "round_step">): number {
  switch (rule.rounding) {
    case "charm_99":
      return Math.floor(floor / 100) * 100 + 99
    case "charm_49_99":
      return roundToRetailEnding(floor)
    case "round_to": {
      const s = step(rule.round_step)
      return Math.ceil(floor / s) * s
    }
    default:
      return floor
  }
}

/** Steps 1 to 3, or why there is no price. */
export function rulePrice(
  rule: SellRule,
  item: Pick<InventoryItem, "market" | "cost">
): { price: number } | { missing: string } {
  let base: number
  if (rule.start === "market_pct") {
    if (item.market === null || item.market <= 0) return { missing: "No market price" }
    base = applyPercent(item.market, rule.start_value)
  } else if (rule.start === "cost_markup") {
    if (!(item.cost > 0)) return { missing: "No cost" }
    base = applyPercent(item.cost, 100 + rule.start_value)
  } else {
    base = Math.max(0, Math.round(rule.start_value))
  }
  const adjusted = applyPercent(base, 100 + rule.adjust_pct)
  return { price: Math.max(0, applyRounding(adjusted, rule)) }
}

export function evaluate(rule: SellRule, item: InventoryItem): RuleResult {
  if (rule.protect_hand && item.hand_priced) {
    return { item, outcome: "skip", proposed: null, reason: "Hand-stickered" }
  }
  const priced = rulePrice(rule, item)
  if ("missing" in priced) return { item, outcome: "skip", proposed: null, reason: priced.missing }

  let proposed = priced.price
  let limited = false
  if (rule.never_below_cost && item.cost > 0 && proposed < item.cost) {
    proposed = roundUpTo(item.cost, rule)
    limited = true
  }
  if (proposed <= 0) return { item, outcome: "skip", proposed: null, reason: "Works out at £0.00" }
  if (proposed === item.price) return { item, outcome: "skip", proposed: null, reason: "Already at this price" }

  if (rule.max_change_pct > 0 && item.price > 0) {
    const change = Math.abs(proposed - item.price) * 100
    if (change > item.price * rule.max_change_pct) {
      return { item, outcome: "approval", proposed, reason: `More than ${rule.max_change_pct}% change` }
    }
  }
  if (limited) return { item, outcome: "limited", proposed, reason: "Held at cost" }
  return { item, outcome: "update", proposed, reason: item.price > 0 ? "" : "New sticker" }
}

export interface MatchContext {
  /** Category id to its path ("Trading cards / Pokémon"), for branch matching. */
  categoryPaths: Readonly<Record<string, string>>
}

export function matches(rule: SellRule, item: InventoryItem, ctx: MatchContext): boolean {
  switch (rule.match) {
    case "game":
      return !rule.match_game || item.game === rule.match_game
    case "kind":
      return !rule.match_kind || item.kind === rule.match_kind
    case "category": {
      if (!rule.match_category) return true
      if (item.category === rule.match_category) return true
      const path = ctx.categoryPaths[rule.match_category]
      return Boolean(path && item.category_path.startsWith(`${path} / `))
    }
    default:
      return true
  }
}

export interface Preview {
  results: RuleResult[]
  counts: Record<Outcome, number>
  /** Sticker value moved by the changes that would go ahead or wait, per unit times quantity. */
  totalChange: number
  matched: number
}

export function preview(rule: SellRule, items: readonly InventoryItem[], ctx: MatchContext): Preview {
  const counts: Record<Outcome, number> = { update: 0, limited: 0, approval: 0, skip: 0 }
  const results: RuleResult[] = []
  let totalChange = 0
  for (const item of items) {
    if (!matches(rule, item, ctx)) continue
    const result = evaluate(rule, item)
    counts[result.outcome] += 1
    if (result.proposed !== null) totalChange += (result.proposed - item.price) * Math.max(1, item.qty)
    results.push(result)
  }
  return { results, counts, totalChange, matched: results.length }
}

/**
 * Which results go straight through and which wait for Approve. An "ask"
 * rule sends everything to the queue; an "auto" rule applies what is within
 * its limits and queues only what broke the maximum change.
 */
export function splitForApply(rule: Pick<SellRule, "approval">, results: readonly RuleResult[]) {
  const changing = results.filter((r) => r.proposed !== null)
  if (rule.approval === "ask") return { apply: [] as RuleResult[], queue: changing }
  return {
    apply: changing.filter((r) => r.outcome === "update" || r.outcome === "limited"),
    queue: changing.filter((r) => r.outcome === "approval"),
  }
}
