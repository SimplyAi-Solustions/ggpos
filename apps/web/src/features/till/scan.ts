/**
 * What a scan or a typed line in the till's field means.
 *
 * Everything the counter's own scanner routing knows (an item, a customer
 * card, a reward voucher, a retail barcode), plus the two things only the
 * till takes: a receipt number, which opens Returns with that sale, and
 * plain words, which search the catalogue and the stock.
 *
 * A receipt prints its number twice: as text, "GG-S-000456", and as a
 * barcode of the same without the dashes, "GGS000456" (ReceiptData.barcode).
 * That barcode is nine characters starting GGS, which is also the shape of a
 * single's SKU, so a nine-character all-digit code that also passes the SKU
 * check is marked `alsoItem`: the till tries the item first and the sale
 * second. Every other GGS-and-digits code is a receipt.
 *
 * Pure, so it is unit tested without a router.
 */
import { parseCode } from "@gg/shared"

import { routeScannedCode, type ScanOutcome } from "@/lib/scanning/route-code"

export type TillScan =
  | ScanOutcome
  | {
      kind: "receipt"
      /** The sale number as the lookup takes it, "GG-S-000456". */
      number: string
      /** Set when the same characters are also a valid item SKU. */
      alsoItem: string | null
    }
  | { kind: "search"; query: string }

const RECEIPT_TEXT = /^GG-S-(\d{6,})(?:-R\d+)?$/i
const RECEIPT_BARCODE = /^GGS(\d{6,})(?:R\d+)?$/i
/** Something that looks like one of our codes, typed or scanned wrong. */
const CODE_LIKE = /^GG[A-Z]-?[0-9A-Z]{5,6}$/i

export function saleNumber(digits: string): string {
  return `GG-S-${digits}`
}

export function readTillScan(raw: string): TillScan {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "unknown", message: "Scan an item or type what you are looking for." }

  const text = RECEIPT_TEXT.exec(trimmed)
  if (text?.[1]) return { kind: "receipt", number: saleNumber(text[1]), alsoItem: null }

  const compact = trimmed.replace(/\s+/g, "")
  const barcode = RECEIPT_BARCODE.exec(compact)
  if (barcode?.[1]) {
    const sku = parseCode(compact)
    return {
      kind: "receipt",
      number: saleNumber(barcode[1]),
      alsoItem: sku && sku.kind === "single" ? sku.encoded : null,
    }
  }

  const routed = routeScannedCode(trimmed)
  if (routed.kind !== "unknown") return routed

  // A code with a bad check character is a misread, not a search.
  if (CODE_LIKE.test(compact)) return routed

  return { kind: "search", query: trimmed }
}

/**
 * Whether typing this so far is worth a live search: words, not something
 * a scanner is halfway through sending.
 */
export function worthSearching(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  if (/^\d+$/.test(trimmed)) return false
  if (/^GG[A-Z]?-?[0-9A-Z-]*$/i.test(trimmed) && !/\s/.test(trimmed)) return false
  return true
}
