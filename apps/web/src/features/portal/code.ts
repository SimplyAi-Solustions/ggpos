/**
 * The emailed sign-in code.
 *
 * PocketBase sends eight digits. People paste them out of a mail app with a
 * space in the middle, with a stray newline, or as "code: 4821 9876", so the
 * field takes whatever arrives and keeps the digits. Everything here is pure
 * so the rules can be tested without a DOM.
 */

export const CODE_LENGTH = 8

/** Digits only, capped at the code's length. */
export function normaliseCodeInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH)
}

export function isCompleteCode(value: string): boolean {
  return normaliseCodeInput(value).length === CODE_LENGTH
}

/** "4821 9876": read aloud in two halves, which is how people say it. */
export function formatCodeForDisplay(value: string): string {
  const digits = normaliseCodeInput(value)
  if (digits.length <= 4) return digits
  return `${digits.slice(0, 4)} ${digits.slice(4)}`
}

/** Seconds before "Send another" wakes up. */
export const RESEND_SECONDS = 60
