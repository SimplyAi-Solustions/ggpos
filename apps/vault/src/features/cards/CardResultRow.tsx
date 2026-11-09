import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"

import { Badge, Money } from "@/ui"

import type { CardRow, GradedPrice } from "./api"
import { CardImage } from "./CardImage"
import { numberLabel } from "./format"
import { LanguageFlag } from "./LanguageFlag"

/** One search result: image, name, variant tag, set, number, language and NM price. */
export function CardResultRow({ card }: { card: CardRow }) {
  return (
    <li>
      <Link
        to="/cards/$id"
        params={{ id: card.id }}
        className="group flex min-h-[84px] items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 ease-gg hover:bg-panel-2 focus-visible:bg-panel-2"
      >
        <CardImage src={card.image_small || card.image_large} alt="" width={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-fg">{card.name}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-fg-2">
            <span className="truncate">{card.set_name || card.set_code}</span>
            <span aria-hidden className="text-fg-3">
              ·
            </span>
            <span className="shrink-0 font-mono tnum">{numberLabel(card)}</span>
          </p>
          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <LanguageFlag language={card.language} />
            {card.variant && <Badge className="min-w-0 truncate whitespace-nowrap">{card.variant}</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {card.nm_pence != null ? (
            <Money pence={card.nm_pence} className="font-bold" />
          ) : (
            <span className="text-sm text-fg-3">No price</span>
          )}
          <span className="label-mono text-[10px] text-fg-3">NM</span>
        </div>
        <ChevronRight className="size-4 shrink-0 text-fg-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  )
}

/** A graded slab as its own row, under the raw card it belongs to. */
export function GradedRow({ card, graded }: { card: CardRow; graded: GradedPrice }) {
  return (
    <li>
      <Link
        to="/cards/$id"
        params={{ id: card.id }}
        className="flex min-h-14 items-center gap-3 rounded-md py-1.5 pr-2 pl-5 transition-colors duration-150 ease-gg hover:bg-panel-2"
      >
        <span className="flex h-[54px] w-[34px] shrink-0 flex-col items-center rounded-[3px] border border-line-2 bg-panel-2 pt-1">
          <span className="h-2 w-6 rounded-[1px] bg-pop/80" aria-hidden />
          <span className="mt-1 h-[34px] w-[24px] overflow-hidden rounded-[2px]">
            <CardImage src={card.image_small} alt="" width={24} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">
            {card.name} <span className="font-mono text-fg-2 tnum">{numberLabel(card)}</span>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone="pop">
              {graded.grader} {graded.grade}
            </Badge>
            <span className="truncate text-xs text-fg-3">{card.set_name}</span>
          </div>
        </div>
        <Money pence={graded.pence} className="font-bold" />
        <ChevronRight className="size-4 shrink-0 text-fg-3" aria-hidden />
      </Link>
    </li>
  )
}
