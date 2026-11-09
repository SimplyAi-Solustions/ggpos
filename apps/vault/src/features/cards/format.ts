import type { CardRow } from "./api"

/** "215/203" when the set total is known, else the number as printed. */
export function numberLabel(card: Pick<CardRow, "number" | "set_total">): string {
  if (card.set_total && /^\d+$/.test(card.number)) return `${card.number}/${card.set_total}`
  return card.number
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
const DAY_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

/** "2 Nov", or "2 Nov 2025" outside the current year. */
export function shortDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ""
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return ""
  return date.getUTCFullYear() === now.getUTCFullYear() ? DAY.format(date) : DAY_YEAR.format(date)
}

/** A multiple as "2.9x", one decimal place. */
export function multipleLabel(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)}x`
}

const NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  "zh-tw": "Traditional Chinese",
  "zh-cn": "Simplified Chinese",
  zh: "Chinese",
  fr: "French",
  de: "German",
  it: "Italian",
  es: "Spanish",
  pt: "Portuguese",
  th: "Thai",
}

/** "Japanese" for "ja"; the code itself for anything unknown. */
export function languageName(code: string): string {
  return NAMES[code.toLowerCase()] ?? code.toUpperCase()
}

