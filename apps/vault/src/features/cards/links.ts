/** Research links out: eBay UK sold listings and Cardmarket search. */
import type { CardRow } from "./api"

const CARDMARKET_GAME: Record<string, string> = {
  pokemon: "Pokemon",
  mtg: "Magic",
  onepiece: "OnePiece",
  lorcana: "Lorcana",
}

export function researchWords(card: Pick<CardRow, "name" | "number" | "set_name" | "set_total">): string {
  const number = card.set_total ? `${card.number}/${card.set_total}` : card.number
  return [card.name, number, card.set_name].filter(Boolean).join(" ")
}

export function ebaySoldUrl(card: Pick<CardRow, "name" | "number" | "set_name" | "set_total">): string {
  const q = new URLSearchParams({ _nkw: researchWords(card), LH_Sold: "1", LH_Complete: "1", _sop: "13" })
  return `https://www.ebay.co.uk/sch/i.html?${q.toString()}`
}

export function cardmarketUrl(card: Pick<CardRow, "name" | "game">): string {
  const game = CARDMARKET_GAME[card.game] ?? "Pokemon"
  return `https://www.cardmarket.com/en/${game}/Products/Search?${new URLSearchParams({ searchString: card.name }).toString()}`
}

const SOURCE_LABELS: Record<string, string> = {
  uk_sold_manual: "UK sold",
  ebay_uk_asking: "eBay UK asking",
  cardmarket: "Cardmarket",
  tcgplayer: "TCGplayer",
  pricecharting_pal: "PriceCharting PAL",
  pricecharting_ntsc: "PriceCharting NTSC",
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

/** A foreign amount as supporting detail ("€12.40"), only ever shown beside its GBP figure. */
export function formatNative(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100)
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`
  }
}
