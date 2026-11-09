import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { BookmarkCheckIcon, BookmarkPlusIcon, CheckIcon, LayersIcon, PlusIcon, SearchIcon } from "lucide-react"

import { img, type BinderCard } from "@/features/binders/api"
import { InStockBadge } from "@/features/binders/InStockBadge"

/** Pointer tilt and holo glare for a card in its sleeve. Touch skips it: a tap is a tick, not a tilt. */
function tiltMove(e: React.PointerEvent<HTMLElement>) {
  if (e.pointerType === "touch") return
  const el = e.currentTarget.querySelector<HTMLElement>(".bx-art")
  if (!el) return
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  el.style.setProperty("--ry", `${(x - 0.5) * 18}deg`)
  el.style.setProperty("--rx", `${(0.5 - y) * 18}deg`)
  el.style.setProperty("--gx", `${x * 100}%`)
  el.style.setProperty("--gy", `${y * 100}%`)
  el.classList.add("tilting")
}

function tiltLeave(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget.querySelector<HTMLElement>(".bx-art")
  if (!el) return
  el.style.setProperty("--rx", "0deg")
  el.style.setProperty("--ry", "0deg")
  el.classList.remove("tilting")
}

export type PocketCard = Pick<
  BinderCard,
  "id" | "card_id" | "name" | "number" | "set_name" | "set_total" | "image" | "dex" | "sprite"
>

export function EmptyPocket({
  label,
  onAdd,
  target,
  onTarget,
}: {
  label?: string
  onAdd?: () => void
  target?: boolean
  onTarget?: () => void
}) {
  if (target && onTarget) {
    return (
      <div className="bx-pocket empty target">
        <button type="button" className="bx-sleeve" onClick={onTarget} aria-label={`Move here${label ? `, ${label}` : ""}`}>
          <div className="bx-art" />
        </button>
      </div>
    )
  }
  return (
    <div className="bx-pocket empty">
      {onAdd ? (
        <button type="button" className="bx-sleeve bx-add" onClick={onAdd} aria-label={`Add a card${label ? `, ${label}` : ""}`}>
          <div className="bx-art">
            <PlusIcon size={18} aria-hidden="true" />
          </div>
        </button>
      ) : (
        <div className="bx-sleeve" aria-hidden="true">
          <div className="bx-art" />
        </div>
      )}
    </div>
  )
}

/**
 * One pocket. Owned cards are in full colour with a tick and a holo sweep;
 * needed cards are greyscale at 40% opacity. A Pokédex pocket with no card
 * yet shows the Pokémon's sprite instead of a scan.
 */
export function Pocket({
  c,
  owned,
  just = false,
  selected = false,
  selecting = false,
  target = false,
  wanted = false,
  wantBusy = false,
  compact = false,
  inStock = false,
  onTap,
  onWant,
  onInspect,
}: {
  c: PocketCard
  owned: boolean
  just?: boolean
  selected?: boolean
  selecting?: boolean
  target?: boolean
  wanted?: boolean
  wantBusy?: boolean
  compact?: boolean
  /** The shop has this exact print on the shelf; only needed cards show it. */
  inStock?: boolean
  onTap?: () => void
  onWant?: () => void
  /** Opens the magnifier for this card. */
  onInspect?: () => void
}) {
  const [broken, setBroken] = React.useState(false)
  const total = c.set_total && /^\d+$/.test(c.number) ? `/${c.set_total}` : ""
  const art = c.image && !broken ? img(c.image) : ""
  const sprite = !art && c.sprite ? c.sprite : ""
  const inShop = inStock && !owned
  const state = owned ? "Collected" : inShop ? "Needed, in stock at GG Entertainment" : "Needed"
  const action = target
    ? "Tap to move the chosen cards here."
    : selecting
      ? selected
        ? "Chosen. Tap to unchoose."
        : "Tap to choose."
      : owned
        ? "Tap to mark it needed."
        : "Tap to mark it collected."
  const Tag = onTap ? "button" : "div"
  return (
    <div
      className={[
        "bx-pocket",
        owned ? "got" : "need",
        just ? "just" : "",
        selected ? "sel" : "",
        target ? "target" : "",
        wanted ? "wanted" : "",
        sprite ? "dex" : "",
        inShop ? "instock" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Tag
        type={onTap ? "button" : undefined}
        className="bx-sleeve"
        onClick={onTap}
        onPointerMove={tiltMove}
        onPointerLeave={tiltLeave}
        aria-pressed={onTap && !target ? (selecting ? selected : owned) : undefined}
        aria-label={`${c.name} ${c.number}${total}. ${state}${wanted ? ", asked for at the shop" : ""}. ${onTap ? action : ""}`}
      >
        <div className="bx-art">
          {art ? (
            <img src={art} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          ) : sprite ? (
            <div className="bx-dex-slot">
              <img className="bx-sprite" src={sprite} alt="" loading="lazy" decoding="async" />
              <span className="bx-dex-no">{c.number}</span>
            </div>
          ) : (
            <div className="bx-art-empty">
              <LayersIcon size={16} aria-hidden="true" />
              <span>
                {c.name}
                <br />
                {c.number}
              </span>
            </div>
          )}
          <i className="bx-glare" />
          <i className="bx-holo" />
        </div>
        <AnimatePresence>
          {owned && !selecting ? (
            <motion.span
              className="bx-tick"
              initial={{ scale: 0, rotate: -40 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
            >
              <CheckIcon size={12} strokeWidth={3} />
            </motion.span>
          ) : null}
        </AnimatePresence>
        {selecting ? (
          <span className="bx-check" aria-hidden="true">
            {selected ? <CheckIcon size={12} strokeWidth={3} /> : null}
          </span>
        ) : null}
        {wanted && !owned ? <span className="bx-ribbon">Wanted</span> : null}
        {inShop ? <InStockBadge /> : null}
      </Tag>
      {onInspect && !selecting && !target ? (
        <button type="button" className="bx-find" onClick={onInspect} aria-label={`Look closer at ${c.name}`}>
          <SearchIcon aria-hidden="true" />
        </button>
      ) : null}
      {onWant && !owned && !selecting ? (
        <button
          type="button"
          className={`bx-want ${wanted ? "on" : ""}`}
          onClick={onWant}
          disabled={wantBusy}
          aria-pressed={wanted}
          aria-label={wanted ? `Stop asking the shop for ${c.name}` : `Ask the shop for ${c.name}`}
          title={wanted ? "Cancel wanted" : "Wanted: ask the shop for this card"}
        >
          {wanted ? <BookmarkCheckIcon size={14} aria-hidden="true" /> : <BookmarkPlusIcon size={14} aria-hidden="true" />}
          {!compact ? <span>{wanted ? "Wanted" : "Want"}</span> : null}
        </button>
      ) : null}
      {!compact ? (
        <div className="bx-cap">
          <div className="n">{c.name}</div>
          <div className="s">
            {c.number}
            {total} {c.set_name}
          </div>
        </div>
      ) : null}
    </div>
  )
}
