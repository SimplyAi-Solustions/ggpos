import { z } from "zod"

/**
 * What the customer forms accept, and what they say when they do not.
 *
 * A walk-in customer is allowed to have nothing but a name: PLAN.md is
 * explicit that "a customer with no email on file has no portal until one is
 * added", so an email is never demanded at the counter. A phone number is
 * asked for once, in a hint, because it is what staff search on.
 */

const UK_PHONE = /^[0-9+()\s-]{7,20}$/

export const customerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give the customer's name so the card can be printed.")
    .max(200, "That name is too long for the card."),
  phone: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || UK_PHONE.test(value),
      "A phone number is digits, spaces and an optional +. Check it and try again."
    ),
  email: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || z.email().safeParse(value).success,
      "That email address is missing an @ or a domain. Check it and try again."
    ),
  marketingConsent: z.boolean(),
})

export type CustomerValues = z.input<typeof customerSchema>

/** Digits only, so "07700 900456" and "07700900456" compare as one number. */
export function phoneDigits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "")
}

export interface DuplicateQuery {
  phone: string
  email: string
}

/** Enough typed in to be worth looking for a duplicate. */
export function duplicateQuery(values: {
  phone?: string
  email?: string
}): DuplicateQuery | null {
  const phone = phoneDigits(values.phone)
  const email = (values.email ?? "").trim().toLowerCase()
  const usablePhone = phone.length >= 7 ? phone : ""
  const usableEmail = email.includes("@") && email.includes(".") ? email : ""
  if (!usablePhone && !usableEmail) return null
  return { phone: usablePhone, email: usableEmail }
}

/** Does this existing customer match what is being typed? */
export function matchesQuery(
  candidate: { phone: string; email: string },
  query: DuplicateQuery
): boolean {
  if (query.phone && phoneDigits(candidate.phone) === query.phone) return true
  if (query.email && candidate.email.trim().toLowerCase() === query.email) return true
  return false
}
