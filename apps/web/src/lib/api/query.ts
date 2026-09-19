import type { CardHit } from "@/lib/api/types"

/**
 * The Add stock search box takes one string and works out what staff meant:
 * "sv151 199" is a set and a number, "charizard" is a name, "199" on its own
 * is a number within whatever set they last chose.
 */
export interface CardQuery {
  /** Set code, when a token looks like one ("sv151", "blb"). */
  setCode?: string
  /** Collector number, when a token has digits ("199", "199/165", "0223"). */
  number?: string
  /** Everything else, treated as a name. */
  text?: string
}

const SET_CODE = /^[a-z][a-z0-9]{1,7}$/i
const NUMBER = /^\d{1,4}(\/\d{1,4})?$/

export function parseCardQuery(raw: string): CardQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const query: CardQuery = {}
  const words: string[] = []

  for (const token of tokens) {
    if (!query.number && NUMBER.test(token)) {
      query.number = token
      continue
    }
    if (!query.setCode && words.length === 0 && SET_CODE.test(token) && /\d/.test(token)) {
      query.setCode = token.toLowerCase()
      continue
    }
    words.push(token)
  }

  // A lone short word beside a number is a set code: "blb 223".
  if (!query.setCode && query.number && words.length === 1 && SET_CODE.test(words[0]!)) {
    query.setCode = words[0]!.toLowerCase()
    words.length = 0
  }

  if (words.length) query.text = words.join(" ")
  return query
}

/** Does a collector number match what was typed? "199" matches "199/165". */
export function numberMatches(cardNumber: string, typed: string): boolean {
  const left = cardNumber.toLowerCase()
  const right = typed.toLowerCase()
  if (left === right) return true
  const bare = left.split("/")[0] ?? left
  return bare === right || bare === right.replace(/^0+/, "") || bare.replace(/^0+/, "") === right
}

/** The demo store's matcher. The live filter below mirrors it. */
export function cardMatches(card: CardHit, query: CardQuery, gameKey?: string): boolean {
  if (gameKey && card.gameKey !== gameKey) return false
  if (query.setCode && card.setCode.toLowerCase() !== query.setCode) return false
  if (query.number && !numberMatches(card.number, query.number)) return false
  if (query.text) {
    const needle = query.text.toLowerCase()
    const haystack = `${card.name} ${card.setName} ${card.rarity ?? ""}`.toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return Boolean(query.setCode || query.number || query.text)
}
