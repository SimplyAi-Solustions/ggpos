import { parseDecimalToMinor } from "@gg/shared"
import { z } from "zod"

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

export const addStockSchema = z
  .object({
    gameId: z.string().min(1, "Choose the game this belongs to."),
    kind: z.enum(["single", "graded", "retro", "sealed", "accessory", "other"]),
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

/** The finishes a card actually exists in, filtered down to ones we name. */
export function finishesFor(available: string[] | undefined) {
  if (!available || available.length === 0) return FINISHES
  const known = FINISHES.filter((finish) => available.includes(finish.value))
  return known.length > 0 ? known : FINISHES
}
