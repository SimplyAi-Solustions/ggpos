/**
 * The "Worth grading?" maths: what a PSA 10, PSA 9 or ACE 10 slab of this
 * card is worth against the raw NM price, what grading would cost, the
 * profit if it comes back a 10 or a 9, and one plain verdict.
 *
 * Graded figures come from price_snapshots rows that carry a grader and
 * grade (1789821560_cardintel_graded_snapshots.js): UK sold comps staff or
 * the research agent entered lead, then UK eBay listings after the haircut
 * when the shop has an eBay key. With no graded row at all the panel says
 * so and offers a graded check; nothing here ever invents a slab price.
 *
 * Fees are the shop's own config (settings.grading, pence), with UK
 * starting figures the owner checks against the graders' price lists.
 * Every amount is integer pence.
 */
import { roundHalfUp } from "@gg/shared/money"

export interface GradingConfig {
  /** ACE Grading's standard service, per card. */
  ace_standard_pence: number
  /** PSA's value tier, per card. */
  psa_value_pence: number
  /** Tracked post there and back, per card. */
  postage_pence: number
  /** Under this profit at a 10 the verdict is Marginal. */
  min_profit_pence: number
  /** YYYY-MM-DD the fees were last checked, or "". */
  fees_checked_on: string
}

export const DEFAULT_GRADING: GradingConfig = {
  ace_standard_pence: 1500,
  psa_value_pence: 2500,
  postage_pence: 800,
  min_profit_pence: 1000,
  fees_checked_on: "",
}

export interface Slab {
  grader: "PSA" | "ACE"
  grade: "10" | "9"
}

/** The slabs the panel and chart show, in display order. */
export const SLABS: readonly Slab[] = [
  { grader: "PSA", grade: "10" },
  { grader: "PSA", grade: "9" },
  { grader: "ACE", grade: "10" },
]

export function slabKey(slab: { grader: string; grade: string }): string {
  return `${slab.grader} ${slab.grade}`
}

export interface GradedPoint {
  /** YYYY-MM-DD */
  at: string
  pence: number
  source: string
  grader: string
  grade: string
}

export interface SlabPrice {
  grader: string
  grade: string
  pence: number
  /** YYYY-MM-DD of the figure. */
  at: string
  /** The snapshot source the figure came from. */
  source: string
  /** Rows behind it. */
  count: number
  /** True when it is a median of recent UK sold comps rather than one listing read. */
  fromSales: boolean
}

/** Only UK sold comps this recent set a slab's price on their own. */
export const SALES_WINDOW_DAYS = 90
const SALES_SAMPLE = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : roundHalfUp((sorted[mid - 1]! + sorted[mid]!) / 2)
}

function daysAgo(at: string, now: Date): number {
  return (now.getTime() - new Date(`${at.slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000
}

/**
 * One price per slab from its graded points: the median of the latest five
 * UK sold comps inside the window when there are any, else the newest point
 * of any source (a UK listing read). Slabs with no points are left out.
 */
export function summariseGraded(points: readonly GradedPoint[], now: Date = new Date()): SlabPrice[] {
  const bySlab = new Map<string, GradedPoint[]>()
  for (const p of points) {
    if (!p.grade || !(p.pence > 0)) continue
    const key = slabKey(p)
    const list = bySlab.get(key) ?? []
    list.push(p)
    bySlab.set(key, list)
  }
  const out: SlabPrice[] = []
  for (const list of bySlab.values()) {
    list.sort((a, b) => b.at.localeCompare(a.at))
    const sales = list.filter((p) => p.source === "uk_sold_manual" && daysAgo(p.at, now) <= SALES_WINDOW_DAYS)
    const first = list[0]!
    if (sales.length) {
      const sample = sales.slice(0, SALES_SAMPLE)
      out.push({ grader: first.grader, grade: first.grade, pence: median(sample.map((p) => p.pence)), at: sample[0]!.at, source: "uk_sold_manual", count: list.length, fromSales: true })
    } else {
      out.push({ grader: first.grader, grade: first.grade, pence: first.pence, at: first.at, source: first.source, count: list.length, fromSales: false })
    }
  }
  return out
}

export function findSlab(slabs: readonly SlabPrice[], slab: Slab): SlabPrice | null {
  return slabs.find((s) => s.grader === slab.grader && s.grade === slab.grade) ?? null
}

/** What grading with this grader costs per card, fees plus post. */
export function feeFor(grader: string, config: GradingConfig): number {
  const service = grader === "ACE" ? config.ace_standard_pence : config.psa_value_pence
  return service + config.postage_pence
}

export type Verdict = "worth" | "marginal" | "not_worth" | "unknown"

export interface SlabOutcome {
  slab: Slab
  price: SlabPrice | null
  /** Slab price over raw NM, or null without both. */
  multiple: number | null
  fee: number
  /** Slab price minus raw minus fee, or null without a slab price. */
  profit: number | null
}

export interface GradingOutcome {
  raw: number | null
  rows: SlabOutcome[]
  verdict: Verdict
  /** One sentence behind the verdict. */
  reason: string
  /** The 10 the verdict rests on, when there is one. */
  best: SlabOutcome | null
}

/** Raw, graded and fees into the three rows and a verdict. */
export function gradingOutcome(raw: number | null, slabs: readonly SlabPrice[], config: GradingConfig): GradingOutcome {
  const rows: SlabOutcome[] = SLABS.map((slab) => {
    const price = findSlab(slabs, slab)
    const fee = feeFor(slab.grader, config)
    return {
      slab,
      price,
      multiple: price && raw ? price.pence / raw : null,
      fee,
      profit: price && raw != null ? price.pence - raw - fee : null,
    }
  })

  const tens = rows.filter((r) => r.slab.grade === "10" && r.profit != null)
  if (raw == null || !tens.length) {
    return {
      raw,
      rows,
      verdict: "unknown",
      best: null,
      reason: raw == null ? "No raw NM price yet, so there is nothing to compare a slab against." : "No graded sales recorded yet.",
    }
  }
  const best = tens.reduce((a, b) => (b.profit! > a.profit! ? b : a))
  const profit10 = best.profit!
  const label = slabKey(best.slab)
  if (profit10 <= 0) {
    return { raw, rows, best, verdict: "not_worth", reason: `A ${label} would not cover the raw price plus fees.` }
  }
  if (profit10 < config.min_profit_pence) {
    return { raw, rows, best, verdict: "marginal", reason: `A ${label} clears less than the shop's minimum.` }
  }
  const nine = rows.find((r) => r.slab.grader === best.slab.grader && r.slab.grade === "9")
  if (nine?.profit != null && nine.profit < 0) {
    return { raw, rows, best, verdict: "marginal", reason: `A ${label} pays, but a ${slabKey(nine.slab)} loses money.` }
  }
  return {
    raw,
    rows,
    best,
    verdict: "worth",
    reason: nine?.profit != null ? `A ${label} pays and a ${slabKey(nine.slab)} still breaks even.` : `A ${label} pays well over the raw price and fees.`,
  }
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  worth: "Worth grading",
  marginal: "Marginal",
  not_worth: "Not worth it",
  unknown: "No graded data",
}
