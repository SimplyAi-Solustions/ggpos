/**
 * The files the shop can take out, in the order the Exports screen lists
 * them: the two that go to somebody else first, then the shop's own records,
 * then the two an admin keeps for HMRC.
 *
 * Every path here is a route in docs/api-contract.md's Phase 4 section,
 * except the audit log, which lives with the reports.
 */
import type { ExportKey } from "@/lib/api/types"

export interface ExportDef {
  key: ExportKey
  label: string
  note: string
  /** Only an admin may take this one. */
  admin?: boolean
  /** Needs the dated range at the top of the section. */
  dated?: boolean
}

export const EXPORTS: ExportDef[] = [
  {
    key: "sumup",
    label: "SumUp items",
    note: "Retro, sealed and accessory lines in stock, in SumUp's own import layout. Downloading marks them as sent.",
  },
  {
    key: "ebay-listings",
    label: "eBay listing file",
    note: "A bulk listing file for what is in stock, ebay.co.uk in pounds. The category and condition are picked in Seller Hub.",
  },
  {
    key: "inventory",
    label: "Inventory",
    note: "Every item on file, whatever its status, with cost, market and sell price.",
  },
  {
    key: "sales",
    label: "Sales",
    note: "One row per line sold in the range, at the figures it sold at.",
    dated: true,
  },
  {
    key: "buy-in-register",
    label: "Buy-in register",
    note: "One row per accepted line, with the seller snapshot. The record local dealer rules ask for.",
    admin: true,
    dated: true,
  },
  {
    key: "stock-book",
    label: "Stock book",
    note: "The VAT margin scheme record: what each item cost, what it sold for and the margin.",
    admin: true,
    dated: true,
  },
  {
    key: "audit",
    label: "Audit log",
    note: "Every audited action in the range, with who did it and what it touched.",
    admin: true,
    dated: true,
  },
]

export interface ExportPathInput {
  from: string
  to: string
  /** SumUp only: also include lines that have changed since the range start. */
  sumupChanged: boolean
  /** eBay listing file only: the items to write. */
  ids: string[]
}

/** The route and query string one export row calls. */
export function exportPath(key: ExportKey, input: ExportPathInput): string {
  switch (key) {
    case "sumup":
      // Leaving `since` off is the narrowest call: only lines SumUp has
      // never seen. Adding it widens the file to lines that have changed.
      return input.sumupChanged
        ? `/api/vault/exports/sumup.csv?since=${input.from}`
        : "/api/vault/exports/sumup.csv"
    case "ebay-listings":
      return `/api/vault/exports/ebay-listings.csv?ids=${input.ids.join(",")}`
    case "inventory":
      return "/api/vault/exports/inventory.csv"
    case "sales":
      return `/api/vault/exports/sales.csv?from=${input.from}&to=${input.to}`
    case "buy-in-register":
      return `/api/vault/exports/buy-in-register.csv?from=${input.from}&to=${input.to}`
    case "stock-book":
      return `/api/vault/exports/stock-book?from=${input.from}&to=${input.to}`
    case "audit":
      return `/api/vault/reports/audit.csv?from=${input.from}&to=${input.to}`
    default:
      return "/api/vault/exports/end-listings.csv"
  }
}

/** What the file is saved as when the response does not name one. */
export function exportFilename(key: ExportKey, input: ExportPathInput): string {
  const dated = EXPORTS.find((entry) => entry.key === key)?.dated
  return dated
    ? `gg-vault-${key}-${input.from}-${input.to}.csv`
    : `gg-vault-${key}.csv`
}
