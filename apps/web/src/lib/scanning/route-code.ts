import { parseCode, type CodeKindName } from "@gg/shared"

/**
 * What a scanned or typed string means, and where the Scan screen should send
 * it. Pure, so it can be unit tested without a router.
 */

export type ScanOutcome =
  /** An item SKU: GGS, GGG, GGR, GGP, GGA, GGX. */
  | { kind: "item"; sku: string; display: string; itemKind: CodeKindName }
  /** A customer card: GGC. */
  | { kind: "customer"; code: string; display: string }
  /** A reward voucher: GGV. Redeemed on the Sell screen in Phase 6. */
  | { kind: "voucher"; code: string; message: string }
  /** A retail barcode on sealed product. */
  | { kind: "ean"; ean: string }
  /** Anything else. */
  | { kind: "unknown"; message: string }

const ITEM_KINDS: CodeKindName[] = [
  "single",
  "graded",
  "retro",
  "sealed",
  "accessory",
  "other",
]

export const VOUCHER_MESSAGE = "Voucher codes are redeemed on the Sell screen"
export const UNKNOWN_MESSAGE = "Not a GG code. Check the label or type the SKU."

export function routeScannedCode(raw: string): ScanOutcome {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: "unknown", message: UNKNOWN_MESSAGE }

  const parsed = parseCode(trimmed)
  if (parsed) {
    if (ITEM_KINDS.includes(parsed.kind)) {
      return {
        kind: "item",
        sku: parsed.encoded,
        display: parsed.display,
        itemKind: parsed.kind,
      }
    }
    if (parsed.kind === "customer") {
      return { kind: "customer", code: parsed.encoded, display: parsed.display }
    }
    return { kind: "voucher", code: parsed.encoded, message: VOUCHER_MESSAGE }
  }

  // A retail barcode: EAN-8, UPC-A, EAN-13 and the ITF-14 case.
  const digits = trimmed.replace(/[\s-]/g, "")
  if (/^\d{8,14}$/.test(digits)) return { kind: "ean", ean: digits }

  return { kind: "unknown", message: UNKNOWN_MESSAGE }
}
