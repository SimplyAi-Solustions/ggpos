import { formatGBP } from "@gg/shared/money"

import { POCKETS, toPages } from "../lib/item-view"
import type { InventoryItem } from "../types"
import { ItemArt } from "./ItemArt"

/**
 * The cabinet as a binder: dark sleeve pages, three by three, each card in
 * its pocket with the sticker price under it. Staff only, so prices show.
 * The page stays dark in both themes; it is a physical object, like the
 * customer binders it is taken from.
 */
export function BinderGrid({ items, onOpen }: { items: readonly InventoryItem[]; onOpen: (item: InventoryItem) => void }) {
  const pages = toPages(items)
  return (
    <div className="flex flex-col gap-6">
      {pages.map((page, p) => (
        <section
          key={p}
          aria-label={`Binder page ${p + 1} of ${pages.length}`}
          className="relative rounded-[6px_18px_18px_6px] border border-white/10 bg-[linear-gradient(90deg,rgba(0,0,0,.4),transparent_5%),linear-gradient(160deg,#1b1b23,#0f0f14)] px-3 pt-4 pb-8 pl-5 text-[#f4f4f0] shadow-[0_24px_44px_-24px_rgba(0,0,0,.7)]"
        >
          {/* The ring-side shadow and the punched holes. */}
          <div aria-hidden className="absolute top-0 bottom-0 left-1.5 flex flex-col justify-around py-10">
            {[0, 1, 2].map((h) => (
              <span key={h} className="size-2 rounded-full bg-black/70 shadow-[inset_0_1px_1px_rgba(255,255,255,.12)]" />
            ))}
          </div>
          <ul className="grid grid-cols-3 gap-x-2.5 gap-y-3.5">
            {page.map((item) => (
              <li key={item.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  aria-label={`${item.title}, ${item.price > 0 ? formatGBP(item.price) : "no price"}. Quick view.`}
                  className="group block w-full rounded-[8px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
                >
                  <span className="relative block rounded-[8px] bg-[linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02))] p-[5%] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1),inset_0_10px_18px_-12px_rgba(255,255,255,.25)]">
                    <ItemArt item={item} glow={false} maxTilt={10} />
                    {/* The sleeve's top lip and its sheen, over the card. */}
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[8%] rounded-t-[8px] bg-[linear-gradient(rgba(255,255,255,.16),rgba(255,255,255,.03))]" />
                    <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[8px] bg-[linear-gradient(118deg,transparent_18%,rgba(255,255,255,.08)_30%,transparent_42%,transparent_64%,rgba(255,255,255,.05)_74%,transparent_84%)]" />
                    {item.qty > 1 && (
                      <span className="absolute top-[7%] right-[7%] rounded-full bg-black/75 px-1.5 py-0.5 font-mono text-[9px] font-bold text-white tnum ring-1 ring-white/20">
                        x{item.qty}
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 block truncate px-0.5 text-[11px] leading-tight text-[#c9c9c2]">{item.title}</span>
                  <span className="block px-0.5 font-mono text-[13px] font-bold text-volt tnum">
                    {item.price > 0 ? formatGBP(item.price) : <span className="text-[#ff7aa0]">No price</span>}
                  </span>
                </button>
              </li>
            ))}
            {Array.from({ length: POCKETS - page.length }, (_, i) => (
              <li key={`blank${i}`} aria-hidden>
                <span className="block aspect-[5/7] rounded-[8px] bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.025)_0_6px,transparent_6px_12px)] shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)]" />
              </li>
            ))}
          </ul>
          <p className="absolute right-5 bottom-2.5 font-mono text-[9.5px] tracking-[0.2em] text-[#8f8f88] uppercase">
            Page {p + 1} / {pages.length}
          </p>
        </section>
      ))}
    </div>
  )
}
