/**
 * Bulk reprint: the three ways staff pick a run of labels, and what comes
 * back when the server has queued them.
 *
 * Pure. The sheet holds the fields and the network call; every rule about
 * what is a valid selection, and every sentence about the outcome, is here
 * so it can be read and tested on its own.
 */
import { isValidCode, normaliseCode } from "@gg/shared"

import type { ItemKind, LabelQueueResult, LabelQueueSelector } from "@/lib/api/types"

/** A buy-in number as it is printed on a receipt and a label. */
export const TRADE_IN_NUMBER = /^GG-BI-\d{6}$/

export type BulkMode = "trade_in" | "dates" | "codes"

export interface BulkForm {
  mode: BulkMode
  /** Typed or scanned: GG-BI-000123. */
  tradeIn: string
  /** YYYY-MM-DD, both inclusive. */
  from: string
  to: string
  location: string
  kind: ItemKind | ""
  game: string
  /** One code, or several separated by commas, spaces or new lines. */
  codes: string
  /** Print a second label for an item that already has one waiting. */
  includeQueued: boolean
}

export function emptyBulkForm(): BulkForm {
  return {
    mode: "trade_in",
    tradeIn: "",
    from: "",
    to: "",
    location: "",
    kind: "",
    game: "",
    codes: "",
    includeQueued: false,
  }
}

/** The codes typed into the sheet, tidied and de-duplicated. */
export function bulkCodes(form: BulkForm): string[] {
  const seen = new Set<string>()
  for (const raw of form.codes.split(/[,\s]+/)) {
    const code = normaliseCode(raw)
    if (code) seen.add(code)
  }
  return [...seen]
}

/**
 * What is wrong with the form, in the words the counter reads, or null when
 * there is nothing wrong with it.
 */
export function bulkProblem(form: BulkForm): string | null {
  if (form.mode === "trade_in") {
    const number = form.tradeIn.trim().toUpperCase()
    if (!number) return "Scan or type the buy-in number, for example GG-BI-000123."
    if (!TRADE_IN_NUMBER.test(number)) {
      return `${number} is not a buy-in number. They look like GG-BI-000123.`
    }
    return null
  }

  if (form.mode === "dates") {
    if (!form.from && !form.to) return "Give the dates the stock came in between."
    if (form.from && form.to && form.from > form.to) {
      return "The first date is after the second one."
    }
    return null
  }

  const codes = bulkCodes(form)
  if (codes.length === 0) return "Scan the labels, or type the codes with commas between."
  const bad = codes.find((code) => !isValidCode(code))
  if (bad) return `${bad} is not a GG code. Check the label and type it again.`
  return null
}

/** The buy-in number to look up, when that is the way in. */
export function tradeInNumber(form: BulkForm): string {
  return form.mode === "trade_in" ? form.tradeIn.trim().toUpperCase() : ""
}

/**
 * The selector to send.
 *
 * The counter resolves a buy-in number and a run of codes into ids before
 * it asks, because the route takes ids; everything else goes as it was
 * typed.
 */
export function bulkSelector(
  form: BulkForm,
  resolved: { tradeInId?: string; itemIds?: string[] } = {}
): LabelQueueSelector {
  const base: LabelQueueSelector = form.includeQueued ? { include_queued: true } : {}

  if (form.mode === "trade_in") {
    return { ...base, trade_in: resolved.tradeInId ?? "" }
  }

  if (form.mode === "codes") {
    return { ...base, items: resolved.itemIds ?? [] }
  }

  return {
    ...base,
    ...(form.from ? { acquired_from: form.from } : {}),
    ...(form.to ? { acquired_to: form.to } : {}),
    ...(form.location ? { location: form.location } : {}),
    ...(form.kind ? { kind: form.kind } : {}),
    ...(form.game ? { game: form.game } : {}),
  }
}

function labels(count: number): string {
  return count === 1 ? "1 label" : `${count} labels`
}

/** What the sheet says once the server has answered, in one line. */
export function queueOutcome(result: LabelQueueResult): string {
  if (result.queued === 0 && result.skipped === 0) {
    return "Nothing matched that, so nothing was queued."
  }
  if (result.queued === 0) {
    return `Nothing new to print. ${labels(result.skipped)} ${
      result.skipped === 1 ? "is" : "are"
    } already waiting.`
  }
  if (result.skipped === 0) {
    return `${labels(result.queued)} queued.`
  }
  return `${labels(result.queued)} queued. ${labels(result.skipped)} ${
    result.skipped === 1 ? "was" : "were"
  } already waiting.`
}
