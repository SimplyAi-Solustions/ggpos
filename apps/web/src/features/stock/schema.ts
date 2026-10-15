import {
  formatGBP,
  parseDecimalToMinor,
  treatmentLabel,
  treatmentOf,
  VAT_TREATMENTS,
} from "@gg/shared"
import { z } from "zod"

import type { StockItemRecord } from "@/lib/api/types"

/**
 * What Add stock accepts, and what it says when it does not.
 *
 * Money arrives as the string the staff member typed and is only ever turned
 * into pence by `parseDecimalToMinor`, so no float touches a price. Every
 * message says what to do next, not what went wrong.
 */

export const FINISHES = [
  { value: "normal", label: "Normal" },
  { value: "holo", label: "Holo" },
  { value: "reverse", label: "Reverse" },
  { value: "first_edition", label: "First edition" },
  { value: "foil", label: "Foil" },
  { value: "etched", label: "Etched" },
] as const

export const CONDITIONS = [
  { value: "NM", label: "NM" },
  { value: "LP", label: "LP" },
  { value: "MP", label: "MP" },
  { value: "HP", label: "HP" },
  { value: "DMG", label: "DMG" },
] as const

export const COMPLETENESS = [
  { value: "loose", label: "Loose" },
  { value: "boxed", label: "Boxed" },
  { value: "cib", label: "CIB" },
] as const

export const KINDS = [
  { value: "single", label: "Card single" },
  { value: "graded", label: "Graded card" },
  { value: "sealed", label: "Sealed product" },
  { value: "retro", label: "Retro game" },
  { value: "accessory", label: "Accessory" },
  { value: "other", label: "Other" },
] as const

/** Singles, graded cards and retro are one row per unit with one label each. */
export const SINGLE_QTY_KINDS = new Set(["single", "graded", "retro"])

/** Only these ask for a card from the catalogue. */
export const CARD_KINDS = new Set(["single", "graded"])

const MONEY_HINT = "Enter an amount in pounds and pence, like 4.50."

const money = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is needed so the margin report adds up.`)
    .refine((value) => parseDecimalToMinor(value) !== null, MONEY_HINT)
    .refine((value) => (parseDecimalToMinor(value) ?? -1) >= 0, "Amounts cannot be negative.")

/**
 * How the item is sold for VAT: one of the five treatments
 * (docs/api-contract-launch.md, section 3), labelled at the standard 20
 * percent; the screen relabels them at the shop's own standard rate.
 */
export const TAX_SCHEMES = VAT_TREATMENTS.map((value) => ({ value, label: treatmentLabel(value) }))

export const addStockSchema = z
  .object({
    /** The branch it is filed in; empty, the server files it by kind and game. */
    categoryId: z.string().optional(),
    gameId: z.string().min(1, "Choose the game this belongs to."),
    kind: z.enum(["single", "graded", "retro", "sealed", "accessory", "other"]),
    taxScheme: z.enum(["margin", "standard", "reduced", "zero", "exempt"]).default("standard"),
    cardId: z.string().optional(),
    title: z.string().trim().optional(),
    setCode: z.string().trim().optional(),
    number: z.string().trim().optional(),
    finish: z.string().optional(),
    condition: z.enum(["NM", "LP", "MP", "HP", "DMG"]).optional(),
    completeness: z.enum(["loose", "boxed", "cib"]).optional(),
    qty: z.coerce.number().int("Quantity is a whole number.").min(1, "Quantity is at least 1."),
    cost: money("Cost"),
    price: money("Price"),
    locationId: z.string().optional(),
    ean: z
      .string()
      .trim()
      .optional()
      .refine(
        (value) => !value || /^\d{8,14}$/.test(value),
        "An EAN is 8 to 14 digits. Scan it again or leave it blank."
      ),
    notes: z.string().max(200, "Notes stop at 200 characters.").optional(),
    /**
     * Who it is ordered from, how many to keep on the shelf and their code
     * (docs/api-contract-reorder.md, section 4.3). Only stock lines carry
     * them: a card single or a graded card is never reordered.
     */
    supplierId: z.string().optional(),
    shelfTarget: z
      .string()
      .trim()
      .optional()
      .refine((value) => !value || /^\d+$/.test(value), "Keep on shelf is a whole number, 0 or more."),
    supplierCode: z.string().trim().max(40, "A supplier code stops at 40 characters.").optional(),
  })
  .superRefine((value, ctx) => {
    if (CARD_KINDS.has(value.kind) && !value.cardId) {
      ctx.addIssue({
        code: "custom",
        path: ["cardId"],
        message: "Search the set and number, or the card name, and choose one.",
      })
    }
    if (!CARD_KINDS.has(value.kind) && !value.cardId && !value.title) {
      ctx.addIssue({
        code: "custom",
        path: ["title"],
        message: "Give the item a title so it can be found on the shelf.",
      })
    }
    if (CARD_KINDS.has(value.kind) && !value.condition) {
      ctx.addIssue({
        code: "custom",
        path: ["condition"],
        message: "Pick a condition so the price band applies.",
      })
    }
    if (value.kind === "retro" && !value.completeness) {
      ctx.addIssue({
        code: "custom",
        path: ["completeness"],
        message: "Say whether it is loose, boxed or complete in box.",
      })
    }
    if (SINGLE_QTY_KINDS.has(value.kind) && value.qty !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["qty"],
        message: "Singles, graded cards and retro are one row each. Save it again for a second copy.",
      })
    }
  })

export type AddStockValues = z.input<typeof addStockSchema>
export type AddStockParsed = z.output<typeof addStockSchema>

/**
 * Every kind but a card single and a graded card takes a supplier, a Keep
 * on shelf target and a supplier code (docs/api-contract-reorder.md,
 * section 4.3): a card is bought in one at a time, never reordered.
 */
export function takesSupplier(kind: string): boolean {
  return !CARD_KINDS.has(kind)
}

/** Pence as the text a money field holds: 123456 is "1234.56", nothing is "". */
function poundsField(pence: number | undefined): string {
  if (typeof pence !== "number" || !Number.isFinite(pence)) return ""
  return formatGBP(pence).replace("£", "").replace(/,/g, "")
}

/**
 * Add more of this (section 4.3): the form filled from a stock row, with
 * its kind, game, branch, title, barcode, price, cost, VAT, supplier, Keep
 * on shelf, supplier code and location. The quantity is left empty for
 * staff to count what came in, unless the kind is always one per row.
 */
export function valuesFromItem(
  item: Pick<
    StockItemRecord,
    | "kind"
    | "game"
    | "category"
    | "title"
    | "ean"
    | "price"
    | "cost"
    | "tax_scheme"
    | "vat_rate"
    | "location"
    | "supplier"
    | "shelf_target"
    | "supplier_code"
  >
): Partial<AddStockValues> {
  const supplier = takesSupplier(item.kind)
  return {
    kind: item.kind,
    gameId: item.game ?? "",
    categoryId: item.category ?? "",
    title: item.title ?? "",
    ean: item.ean ?? "",
    price: poundsField(item.price),
    cost: poundsField(item.cost),
    taxScheme: treatmentOf(item.tax_scheme, item.vat_rate) ?? "standard",
    locationId: item.location || undefined,
    supplierId: supplier ? (item.supplier ?? "") : "",
    shelfTarget: supplier && item.shelf_target && item.shelf_target > 0 ? String(item.shelf_target) : "",
    supplierCode: supplier ? (item.supplier_code ?? "") : "",
    qty: SINGLE_QTY_KINDS.has(item.kind) ? 1 : "",
  }
}

/** A Keep on shelf field as the item stores it: a whole number, or null for none. */
export function shelfTargetValue(text: string | undefined): number | null {
  const clean = (text ?? "").trim()
  if (!/^\d+$/.test(clean)) return null
  const value = Number(clean)
  return value > 0 ? value : null
}

/**
 * The finish a card is priced in until somebody taps another chip.
 *
 * `price_snapshots.finish` is matched exactly by every price route, so a
 * card looked up with no finish finds no snapshots at all. The card's own
 * first printing is the honest default; "normal" covers a catalogue row that
 * lists none, which is what a manual card has.
 */
export function defaultFinish(available: string[] | undefined): string {
  const known: string[] = finishesFor(available).map((finish) => finish.value)
  const first = (available ?? []).find((finish) => known.includes(finish))
  return first ?? known[0] ?? "normal"
}

/** The finishes a card actually exists in, filtered down to ones we name. */
export function finishesFor(available: string[] | undefined) {
  if (!available || available.length === 0) return FINISHES
  const known = FINISHES.filter((finish) => available.includes(finish.value))
  return known.length > 0 ? known : FINISHES
}
