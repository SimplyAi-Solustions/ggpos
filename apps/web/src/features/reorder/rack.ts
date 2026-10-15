/**
 * The supplier call's own small rules (docs/api-contract-reorder.md,
 * section 4.2), kept pure so they are tested apart from the screen. The
 * adding up itself is `@gg/shared`'s reorder module and is never redone here.
 */
import type { ReorderLine, ReorderSupplier, StockRequestView } from "@gg/shared"

/** The rack's four chips, in the order they sit. */
export const RACK_VIEWS = [
  { key: "to_order", label: "To order" },
  { key: "out", label: "Out of stock" },
  { key: "sold", label: "Sold" },
  { key: "all", label: "Everything" },
] as const

export type RackView = (typeof RACK_VIEWS)[number]["key"]

export const RACK_VIEW_KEYS = RACK_VIEWS.map((view) => view.key) as [RackView, ...RackView[]]

/**
 * The lines a chip shows. To order, Out of stock and Everything keep the
 * shared order (most to order first); Sold leads with what sold most, which
 * is what the call is about on that chip.
 */
export function rackLines(lines: readonly ReorderLine[], view: RackView): ReorderLine[] {
  switch (view) {
    case "to_order":
      return lines.filter((line) => line.toOrder > 0)
    case "out":
      return lines.filter((line) => line.status === "out")
    case "sold":
      return lines
        .filter((line) => line.sold > 0)
        .sort(
          (a, b) =>
            b.sold - a.sold || a.title.localeCompare(b.title, "en-GB", { sensitivity: "base" })
        )
    default:
      return [...lines]
  }
}

/**
 * The order as text to paste into an email or read down the phone: "code,
 * title, quantity", one line per product with something to order, in the
 * report's order. A product with no supplier code goes by its barcode, and
 * by its title alone when it has neither.
 */
export function orderText(lines: readonly ReorderLine[]): string {
  return lines
    .filter((line) => line.toOrder > 0)
    .map((line) =>
      [line.supplierCode || line.ean, line.title, String(line.toOrder)].filter(Boolean).join(", ")
    )
    .join("\n")
}

/**
 * "Rep: Dan, 07700 900321, dan@example.co.uk. Account GW-48213", saying only
 * what is set, or "" when nothing is.
 */
export function repLine(
  supplier: Pick<ReorderSupplier, "repName" | "repPhone" | "repEmail" | "accountNumber">
): string {
  const rep = [supplier.repName, supplier.repPhone, supplier.repEmail]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ")
  const account = supplier.accountNumber.trim()
  return [rep ? `Rep: ${rep}.` : "", account ? `Account ${account}` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\.$/, "")
}

/** The item guard's own sentence, said before anything is sent. */
export const SHELF_TARGET_MESSAGE = "Keep on shelf is a whole number, 0 or more."

/**
 * What a Keep on shelf field holds: null for empty (no target), the whole
 * number typed, or an error for anything else.
 */
export function shelfTargetFromText(
  text: string
): { ok: true; value: number | null } | { ok: false; message: string } {
  const clean = text.trim()
  if (!clean) return { ok: true, value: null }
  if (!/^\d+$/.test(clean)) return { ok: false, message: SHELF_TARGET_MESSAGE }
  const value = Number(clean)
  if (!Number.isSafeInteger(value)) return { ok: false, message: SHELF_TARGET_MESSAGE }
  return { ok: true, value: value > 0 ? value : null }
}

/** One chip's empty line, saying what is empty and what to do. */
export function rackEmptyLine(view: RackView, supplierName: string, when: string): string {
  switch (view) {
    case "to_order":
      return "Nothing to order. Every product with a target is at or above it."
    case "out":
      return "Nothing is out of stock."
    case "sold":
      return `Nothing sold ${when}.`
    default:
      return noStockLine(supplierName)
  }
}

/** The report with no products on it at all. */
export function noStockLine(supplierName: string): string {
  return `No ${supplierName} stock yet. Set the supplier and Keep on shelf on an item to put it on this list.`
}

/** Who asked: the member's name and Guild code, or the name to contact. */
export function requestWho(request: Pick<StockRequestView, "customerName" | "customerCode" | "contactName">): {
  name: string
  code: string
} {
  if (request.customerName) return { name: request.customerName, code: request.customerCode }
  return { name: request.contactName || "Not recorded", code: "" }
}

/** "2 units", "1 unit". */
export function units(count: number): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? "unit" : "units"}`
}
