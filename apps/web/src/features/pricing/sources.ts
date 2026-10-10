/**
 * What the side-by-side source view shows, worked out away from the DOM.
 *
 * The price routes only return a row for a source that actually has a figure,
 * but staff need to see the whole order to trust the one that won: the shop's
 * priority list is the spine here, and a source with nothing behind it reads
 * "No value" rather than disappearing. Every supporting line is written here
 * too, so "a foreign amount never appears without its GBP conversion"
 * (CLAUDE.md, "Pricing") is one rule in one place.
 */
import { formatGBP, type PriceSource } from "@gg/shared"

import type { PriceSourceRow, PriceView } from "@/lib/api/types"
import { formatPercent } from "@/lib/format"

/** The sources as docs/api-contract.md names them. */
const LABELS: Record<PriceSource, string> = {
  uk_sold_manual: "UK sold comp",
  ebay_uk_asking: "eBay UK asking",
  cardmarket: "Cardmarket",
  tcgplayer: "TCGplayer",
  pricecharting_pal: "PriceCharting PAL",
  pricecharting_ntsc: "PriceCharting NTSC",
}

const SYMBOLS: Record<"GBP" | "EUR" | "USD", string> = {
  GBP: "£",
  EUR: "€",
  USD: "$",
}

/**
 * One Piece has no TCGplayer feed of its own: the OPTCG API's market price is
 * stored under `tcgplayer` because `price_snapshots.source` is a fixed enum
 * (docs/api-contract.md, Phase 3 implementation notes). The badge says so
 * rather than crediting a feed that was never asked.
 */
export function sourceLabel(source: PriceSource, gameKey?: string): string {
  if (source === "tcgplayer" && gameKey === "onepiece") return "TCGplayer (OPTCG)"
  return LABELS[source] ?? source
}

/**
 * A foreign amount in its own currency. Grouping and the two decimal places
 * come from `formatGBP` rather than a second formatter, so £1,234.56 and
 * €1,234.56 can never drift apart; only the symbol changes.
 */
export function formatNative(minor: number, currency: "GBP" | "EUR" | "USD"): string {
  return formatGBP(minor).replace("£", SYMBOLS[currency] ?? "£")
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/**
 * "20 Sep", the way a counter says a date out loud. Written out rather than
 * left to `toLocaleDateString`, whose en-GB short month for September is
 * "Sept" in current ICU and plain "Sep" in older ones: a price line that
 * changes shape with the browser's data is not worth the saving.
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

/**
 * A finish or a completeness as a person says it: "holo", "first edition",
 * "CIB". Used where the sheet has to name what is being priced, so a comp is
 * never filed against a finish nobody was looking at.
 */
export function finishWords(value: string | undefined): string {
  if (!value) return ""
  if (value.toLowerCase() === "cib") return "CIB"
  return value.replace(/_/g, " ")
}

/** "0.8606", with the trailing zeros of a round rate left off. */
export function formatRate(rate: number | null | undefined): string {
  if (!rate && rate !== 0) return ""
  const fixed = rate.toFixed(4).replace(/0+$/, "")
  return fixed.endsWith(".") ? fixed.slice(0, -1) : fixed
}

/** "4 hours ago", "2 days ago": how old a figure is, in words. */
export function ageLabel(iso: string, now: Date = new Date()): string {
  const fetched = new Date(iso)
  if (Number.isNaN(fetched.getTime())) return ""
  const hours = (now.getTime() - fetched.getTime()) / 36e5
  if (hours < 1) return "just now"
  if (hours < 24) {
    const whole = Math.floor(hours)
    return `${whole} ${whole === 1 ? "hour" : "hours"} ago`
  }
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? "day" : "days"} ago`
}

export interface SourceDetailOptions {
  gameKey?: string
  /** The asking-to-sold haircut from settings, as a whole percent. */
  haircutPct?: number
  /**
   * The ECB date `GET /api/vault/fx` reports for the day's rate. A snapshot
   * written before that field existed carries no `fx_date` of its own, and
   * the conversion detail says which day the rate is from either way.
   */
  fxDate?: string | null
}

/**
 * The line under a source's figure: where it came from, in what currency, at
 * what rate and when.
 */
export function sourceDetail(
  row: PriceSourceRow,
  options: SourceDetailOptions = {}
): string {
  const { gameKey, haircutPct = 15 } = options

  if (row.source === "uk_sold_manual") {
    const when = shortDate(row.fetched_at)
    return when ? `UK sold comp, ebay.co.uk, ${when}` : "UK sold comp, ebay.co.uk"
  }

  if (row.source === "ebay_uk_asking") {
    const when = shortDate(row.fetched_at)
    const head = `eBay UK asking, after the ${formatPercent(haircutPct)} haircut`
    return when ? `${head}, ${when}` : head
  }

  if (row.native_currency !== "GBP") {
    const label = sourceLabel(row.source, gameKey)
    const native = formatNative(row.native_market, row.native_currency)
    const rate = formatRate(row.fx_rate)
    const when = shortDate(row.fx_date || options.fxDate || row.fetched_at)
    const parts = [`from ${label} ${native}`]
    if (rate) parts.push(`at ${rate}`)
    const head = parts.join(" ")
    return when ? `${head}, ${when}` : head
  }

  const when = shortDate(row.fetched_at)
  return when ? `Checked ${when}` : "Checked"
}

export interface SourceRowView {
  source: PriceSource
  label: string
  /** Integer GBP pence, or null when the shop has no figure from this source. */
  gbp: number | null
  chosen: boolean
  stale: boolean
  detail: string
  evidenceUrl: string
}

/**
 * One row per source in the shop's own priority order, whether or not it has
 * a figure. A source the server returned but the priority list does not name
 * (an admin reordering mid-session) is kept on the end rather than dropped.
 */
export function sourceRows(
  view: PriceView | undefined,
  priority: PriceSource[],
  options: SourceDetailOptions = {}
): SourceRowView[] {
  const bySource = new Map<PriceSource, PriceSourceRow>()
  for (const row of view?.sources ?? []) bySource.set(row.source, row)

  const order: PriceSource[] = [...priority]
  for (const row of view?.sources ?? []) {
    if (!order.includes(row.source)) order.push(row.source)
  }

  const chosen = view?.chosen?.source
  return order.map((source) => {
    const row = bySource.get(source)
    return {
      source,
      label: sourceLabel(source, options.gameKey),
      gbp: row ? row.gbp_market : null,
      chosen: Boolean(row) && source === chosen,
      stale: Boolean(row?.stale),
      detail: row ? sourceDetail(row, options) : "",
      evidenceUrl: row?.evidence_url ?? "",
    }
  })
}

/** The one line a buy-in line shows without expanding the whole view. */
export function marketLine(
  view: PriceView | undefined,
  options: SourceDetailOptions & { manual?: boolean; now?: Date } = {}
): string {
  if (options.manual) return "Entered by hand"
  const chosen = view?.chosen
  if (!chosen) return "No price yet. Refresh or enter it."
  const label = sourceLabel(chosen.source, options.gameKey)
  const age = ageLabel(chosen.fetched_at, options.now ?? new Date())
  if (chosen.stale) return `${label}, ${age}. Refresh for a newer figure.`
  return `${label}, ${age}`
}

/** "FX rate is 4 days old. Converted prices may be off." */
export function fxWarning(
  fetchedAt: string | null | undefined,
  now: Date = new Date()
): string {
  if (!fetchedAt) return "No FX rate yet, so no converted price can be shown."
  const days = Math.max(1, Math.floor((now.getTime() - new Date(fetchedAt).getTime()) / 864e5))
  return `FX rate is ${days} ${days === 1 ? "day" : "days"} old. Converted prices may be off.`
}
