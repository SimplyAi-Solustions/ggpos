/**
 * Pure helpers that turn an `items` row into the three things every screen
 * needs from it: the frame its picture goes in, the one grey line under its
 * title, and the label it prints on.
 *
 * Shared by the live and the demo implementations so a card looks the same
 * whichever one answered.
 */
import { productKey } from "@gg/shared"

import type { PlatformKey } from "@/design/platforms"
import type {
  ItemDetail,
  ItemKind,
  ItemPatch,
  LabelTemplateKey,
  StockItemRecord,
} from "@/lib/api/types"

/**
 * The item page's supplier, Keep on shelf and supplier code
 * (docs/api-contract-reorder.md, section 4.1). An empty or 0 target is no
 * target, said as null so the field reads empty rather than "0".
 */
export function supplierFieldsOf(
  item: Pick<StockItemRecord, "supplier" | "shelf_target" | "supplier_code">,
  supplierName = ""
): Pick<ItemDetail, "supplierId" | "supplierName" | "shelfTarget" | "supplierCode"> {
  const target = item.shelf_target
  return {
    supplierId: item.supplier ?? "",
    supplierName: item.supplier ? supplierName : "",
    shelfTarget:
      typeof target === "number" && Number.isFinite(target) && target > 0 ? Math.trunc(target) : null,
    supplierCode: item.supplier_code ?? "",
  }
}

/**
 * The stock rows that are the same product as `item` on its supplier's
 * call: the same supplier, and the same supplier code, else barcode, else
 * title (`productKey` in @gg/shared). The item itself is always one of them.
 * A row with no supplier is a product of its own.
 */
export function productRowIdsIn(
  item: Pick<StockItemRecord, "id" | "supplier" | "supplier_code" | "ean" | "title">,
  rows: readonly Pick<StockItemRecord, "id" | "supplier" | "supplier_code" | "ean" | "title">[]
): string[] {
  if (!item.supplier) return [item.id]
  const keyOf = (row: Pick<StockItemRecord, "supplier_code" | "ean" | "title">) =>
    productKey({ supplierCode: row.supplier_code ?? "", ean: row.ean ?? "", title: row.title ?? "" })
  const key = keyOf(item)
  const ids = rows
    .filter((row) => row.id !== item.id && row.supplier === item.supplier && keyOf(row) === key)
    .map((row) => row.id)
  return [item.id, ...ids]
}

/**
 * The supplier fields of a patch as `items` stores them: a cleared supplier
 * is null, a cleared target is 0 (the contract's "0 or empty is no
 * target"), and a code is trimmed. Only the fields the patch names.
 */
export function supplierPatchBody(
  patch: Pick<ItemPatch, "supplierId" | "shelfTarget" | "supplierCode">
): { supplier?: string | null; shelf_target?: number; supplier_code?: string } {
  const body: { supplier?: string | null; shelf_target?: number; supplier_code?: string } = {}
  if (patch.supplierId !== undefined) body.supplier = patch.supplierId || null
  if (patch.shelfTarget !== undefined) body.shelf_target = patch.shelfTarget ?? 0
  if (patch.supplierCode !== undefined) body.supplier_code = patch.supplierCode.trim()
  return body
}

/**
 * The `ProductImage` frame for a stock row. `items` carries no platform of
 * its own: a card is a card, a graded card is a slab, and everything else
 * falls back to the table's 3:4 default until a retro title names a platform.
 */
export function platformForItem(item: Pick<StockItemRecord, "kind">): PlatformKey {
  switch (item.kind) {
    case "single":
      return "tcg_card"
    case "graded":
      return "graded_slab"
    case "sealed":
      return "etb"
    default:
      return "other"
  }
}

/** "SV151 199/165 Holo", or "PAL Boxed" for retro. Never longer than a line. */
export function itemDetailLine(item: StockItemRecord): string {
  const parts =
    item.kind === "retro"
      ? [item.region, item.completeness, item.finish]
      : [item.set_code?.toUpperCase(), item.number, item.finish]
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => (part.length <= 4 ? part.toUpperCase() : capitalise(part)))
    .join(" ")
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Which of the four label layouts a thing gets: small accessories take the
 * 25x15 sleeve, boxed retro takes the 50x30, everything else the 40x20 top
 * loader. See docs/label-spec.md.
 */
export function templateForItem(
  kind: ItemKind,
  completeness?: string
): LabelTemplateKey {
  if (kind === "accessory") return "sleeve_25x15"
  if (kind === "retro" && (completeness === "boxed" || completeness === "cib")) {
    return "retro_50x30"
  }
  return "toploader_40x20"
}
