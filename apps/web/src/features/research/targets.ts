/**
 * What "Search eBay sold" and "Ask an agent" are about, from each place
 * they sit: a trade-in line, a stock item, or a card in price check. Pure,
 * so the words a line searches for are tested rather than eyeballed.
 */
import type { ResearchTarget } from "@/features/research/ResearchActions"
import type { CardHit, StockItemRecord } from "@/lib/api/types"
import type { TradeLine } from "@/features/tradein/machine"

function kindOf(kind: string | undefined): NonNullable<ResearchTarget["subject"]["kind"]> {
  if (kind === "retro") return "retro"
  if (kind === "graded") return "graded"
  if (kind === "single") return "card"
  if (kind === "sealed") return "sealed"
  return "other"
}

/** A buy-in or part-exchange line. A retro line's completeness rides in its condition. */
export function lineTarget(line: TradeLine): ResearchTarget {
  const retro = line.kind === "retro"
  const finish = retro ? line.condition : line.finish
  return {
    subject: {
      name: line.title,
      setName: line.setName,
      number: line.number,
      finish,
      condition: retro ? undefined : line.condition,
      kind: kindOf(line.kind),
    },
    card: line.cardId,
    retroTitle: line.cardId ? undefined : line.retroTitleId,
    tradeInLine: line.id,
    finish: finish || undefined,
    condition: line.cardId ? line.condition || "NM" : undefined,
  }
}

/** A stock item on its own page. */
export function itemTarget(item: StockItemRecord): ResearchTarget {
  const retro = item.kind === "retro"
  const finish = retro ? item.completeness || "" : item.finish || ""
  return {
    subject: {
      name: item.title || "",
      number: item.number,
      finish,
      condition: retro ? undefined : item.condition || undefined,
      kind: kindOf(item.kind),
      grade: [item.grade_company, item.grade].filter(Boolean).join(" ") || undefined,
    },
    card: item.card || undefined,
    retroTitle: item.card ? undefined : item.retro_title || undefined,
    item: item.id,
    finish: finish || undefined,
    condition: item.card ? item.condition || "NM" : undefined,
  }
}

/** A card in price check, in the finish on screen. */
export function cardTarget(card: CardHit, finish: string): ResearchTarget {
  return {
    subject: { name: card.name, setName: card.setName, number: card.number, finish, kind: "card" },
    card: card.id,
    finish,
    condition: "NM",
  }
}
