import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  BookmarkCheckIcon,
  BookmarkPlusIcon,
  BrushIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  LayersIcon,
} from "lucide-react"

import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { InStockBadge } from "@/features/binders/InStockBadge"
import { baseSpeciesName } from "@/features/binders/artist"
import { createBinder, getCardDetail, img, type CardDetail, type CardMove } from "@/features/binders/api"

/**
 * The magnifier: one card on a dark stage with tilt and shine, its identity
 * and gameplay from TCGdex, and the actions that make sense where it opened.
 * A bottom sheet on a phone, a side panel on a desk (the Sheet does that
 * split itself). No price, ever: the server endpoint is a whitelist and
 * api.ts strips again.
 */

export interface DetailItem {
  id: string
  card_id: string
  name: string
  number: string
  set_name: string
  set_total: string
  image: string
  sprite?: string
  owned: boolean
  wanted?: boolean
  inStock?: boolean
}

const ENERGY: Record<string, string> = {
  Grass: "#7db808",
  Fire: "#e84545",
  Water: "#2f9cd6",
  Lightning: "#fedf01",
  Psychic: "#a65e9a",
  Fighting: "#b06038",
  Darkness: "#3d5a76",
  Metal: "#8e9aa3",
  Fairy: "#e26a8d",
  Dragon: "#b8a038",
  Colorless: "#c8c8c0",
}

function TypeDot({ type }: { type: string }) {
  return (
    <i
      className="bx-energy"
      style={{ background: ENERGY[type] ?? "#c8c8c0" }}
      title={type}
      aria-label={type}
      role="img"
    />
  )
}

function Move({ m }: { m: CardMove }) {
  const energy = m.energy ?? []
  return (
    <div className="bx-detail-move">
      <div className="bx-detail-move-head">
        {m.type ? <span className="bx-detail-move-kind">{m.type}</span> : null}
        {energy.length ? (
          <span className="bx-detail-cost">
            {energy.map((c, i) => (
              <TypeDot key={`${c}${i}`} type={c} />
            ))}
          </span>
        ) : null}
        <b>{m.name}</b>
        {m.damage ? <span className="bx-detail-damage tnum">{m.damage}</span> : null}
      </div>
      {m.effect ? <p>{m.effect}</p> : null}
    </div>
  )
}

function tiltMove(e: React.PointerEvent<HTMLElement>) {
  if (e.pointerType === "touch") return
  const el = e.currentTarget.querySelector<HTMLElement>(".bx-art")
  if (!el) return
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  el.style.setProperty("--ry", `${(x - 0.5) * 14}deg`)
  el.style.setProperty("--rx", `${(0.5 - y) * 14}deg`)
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

export function CardDetailSheet({
  open,
  onOpenChange,
  items,
  index,
  onIndex,
  color = "#fedf01",
  canCreate = false,
  linkArtist = false,
  onToggleOwned,
  onToggleWant,
  wantBusy = false,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  items: DetailItem[]
  index: number
  onIndex: (next: number) => void
  /** The binder's accent colour; drives the stage glow. */
  color?: string
  /** Signed-in contexts can make binders from here. */
  canCreate?: boolean
  /** Signed-in contexts link the artist row to the artist page. */
  linkArtist?: boolean
  onToggleOwned?: (item: DetailItem) => void
  onToggleWant?: (item: DetailItem) => void
  wantBusy?: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const item = items[index]
  const detailQ = useQuery({
    queryKey: ["binder-card-detail", item?.card_id ?? ""],
    queryFn: () => getCardDetail(item!.card_id),
    enabled: open && !!item,
    staleTime: 24 * 3600 * 1000,
    gcTime: 3600 * 1000,
    retry: 1,
  })
  const d: CardDetail | undefined = detailQ.data
  const [busy, setBusy] = React.useState("")
  const [error, setError] = React.useState("")

  // Swipe between cards on the stage.
  const touch = React.useRef<{ x: number; y: number } | null>(null)
  const go = React.useCallback(
    (dir: 1 | -1) => {
      const next = index + dir
      if (next >= 0 && next < items.length) onIndex(next)
    },
    [index, items.length, onIndex]
  )
  React.useEffect(() => {
    if (!open) return undefined
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") go(1)
      else if (e.key === "ArrowLeft") go(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, go])

  async function makeBinder(kind: "pokemon" | "set") {
    if (!d || busy) return
    setBusy(kind)
    setError("")
    const species = baseSpeciesName(d.name)
    try {
      const made =
        kind === "pokemon"
          ? await createBinder({
              kind: "pokemon",
              query: String(d.dex),
              query_label: species,
              name: species,
              owner: "",
              color: "violet",
              grid: "3x3",
            })
          : await createBinder({
              kind: "set",
              query: d.set.id,
              query_label: d.set.name,
              name: d.set.name,
              owner: "",
              color: "cyan",
              grid: "3x3",
            })
      void queryClient.invalidateQueries({ queryKey: ["portal", "binders"] })
      void queryClient.invalidateQueries({ queryKey: ["portal", "binder-pockets"] })
      onOpenChange(false)
      void navigate({ to: "/account/binders/$id", params: { id: made.id } })
    } catch {
      setError("Could not make the binder. Check your connection and try again.")
    }
    setBusy("")
  }

  if (!item) return null
  const owned = item.owned
  const art = item.image ? img(item.image, "high") : ""
  const total = item.set_total && /^\d+$/.test(item.number) ? `/${item.set_total}` : ""
  const status = owned ? "Owned" : item.wanted ? "Wanted" : "Needed"
  const released = d?.set.release_date
    ? new Date(d.set.release_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : ""

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="bx-sheet bx-detail pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle className="sr-only">{`${item.name} ${item.number}${total}`}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div
            className="bx-detail-stage"
            style={{ "--bc": color } as React.CSSProperties}
            onPointerMove={tiltMove}
            onPointerLeave={tiltLeave}
            onTouchStart={(e) => {
              touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
            }}
            onTouchEnd={(e) => {
              const start = touch.current
              touch.current = null
              if (!start) return
              const dx = e.changedTouches[0].clientX - start.x
              const dy = e.changedTouches[0].clientY - start.y
              if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
            }}
          >
            <div className={`bx-pocket ${owned ? "got" : "need"}`}>
              <div className={`bx-art bx-detail-art ${owned ? "" : "bx-detail-need"}`}>
                {art ? (
                  <img src={art} alt={`${item.name} card`} draggable={false} />
                ) : (
                  <div className="bx-art-empty">
                    <LayersIcon size={20} aria-hidden="true" />
                    <span>{item.name}</span>
                  </div>
                )}
                <i className="bx-glare" />
              </div>
            </div>
            <button
              type="button"
              className="bx-arrow bx-detail-arrow prev"
              onClick={() => go(-1)}
              disabled={index <= 0}
              aria-label="Previous card"
            >
              <ChevronLeftIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className="bx-arrow bx-detail-arrow next"
              onClick={() => go(1)}
              disabled={index >= items.length - 1}
              aria-label="Next card"
            >
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </div>

          <div className="bx-detail-body" style={{ "--bc": color } as React.CSSProperties}>
            <div className="bx-detail-pills">
              <span className={`bx-detail-pill ${owned ? "owned" : item.wanted ? "wanted" : "needed"}`}>{status}</span>
              {item.inStock && !owned ? (
                <span className="bx-detail-pill instock">
                  <InStockBadge />
                  In stock at GG
                </span>
              ) : null}
            </div>
            <h2 className="bx-detail-name">{item.name}</h2>
            <p className="bx-detail-set">
              {d?.set.logo ? <img src={`${d.set.logo}.webp`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : null}
              <span>
                {item.set_name || d?.set.name}
                {item.number ? (
                  <>
                    {" "}
                    &middot;{" "}
                    <span className="tnum">
                      {item.number}
                      {total}
                    </span>
                  </>
                ) : null}
              </span>
            </p>
            {detailQ.isPending ? <div className="bx-skel mt-4" style={{ height: 120 }} /> : null}
            {detailQ.isError ? (
              <p className="bx-detail-note">The card catalogue is not answering. The binder still works; try the details again in a minute.</p>
            ) : null}
            {d ? (
              <>
                <div className="bx-detail-facts">
                  {d.rarity ? (
                    <span className="bx-detail-fact">
                      <small>Rarity</small>
                      {d.rarity}
                    </span>
                  ) : null}
                  {d.hp ? (
                    <span className="bx-detail-fact">
                      <small>HP</small>
                      <span className="tnum">{d.hp}</span>
                    </span>
                  ) : null}
                  {d.types.length ? (
                    <span className="bx-detail-fact">
                      <small>Type</small>
                      <span className="bx-detail-cost">
                        {d.types.map((t) => (
                          <TypeDot key={t} type={t} />
                        ))}
                        {d.types.join(", ")}
                      </span>
                    </span>
                  ) : null}
                  {d.stage ? (
                    <span className="bx-detail-fact">
                      <small>Stage</small>
                      {d.stage}
                      {d.evolve_from ? `, from ${d.evolve_from}` : ""}
                    </span>
                  ) : null}
                  {released ? (
                    <span className="bx-detail-fact">
                      <small>Released</small>
                      {released}
                    </span>
                  ) : null}
                </div>

                {d.illustrator ? (
                  linkArtist ? (
                    <button
                      type="button"
                      className="bx-detail-artist"
                      onClick={() => {
                        onOpenChange(false)
                        void navigate({ to: "/account/artists/$name", params: { name: d.illustrator } })
                      }}
                    >
                      <BrushIcon aria-hidden="true" />
                      <span>
                        <small>Illustrated by</small>
                        {d.illustrator}
                      </span>
                      <ChevronRightIcon aria-hidden="true" className="ml-auto" />
                    </button>
                  ) : (
                    <p className="bx-detail-artist-plain">
                      <BrushIcon aria-hidden="true" /> Illustrated by {d.illustrator}
                    </p>
                  )
                ) : null}

                {d.abilities.length ? (
                  <div className="bx-detail-moves">
                    {d.abilities.map((m, i) => (
                      <Move key={`a${i}`} m={m} />
                    ))}
                  </div>
                ) : null}
                {d.attacks.length ? (
                  <div className="bx-detail-moves">
                    {d.attacks.map((m, i) => (
                      <Move key={`m${i}`} m={m} />
                    ))}
                  </div>
                ) : null}
                {d.description ? <p className="bx-detail-flavour">{d.description}</p> : null}
              </>
            ) : null}

            {onToggleOwned || onToggleWant ? (
              <div className="bx-detail-actions">
                {onToggleOwned ? (
                  <button type="button" className="bx-detail-main" onClick={() => onToggleOwned(item)}>
                    {owned ? <CircleDashedIcon aria-hidden="true" /> : <CheckIcon aria-hidden="true" />}
                    {owned ? "Mark needed" : "Mark collected"}
                  </button>
                ) : null}
                {onToggleWant && !owned ? (
                  <button
                    type="button"
                    className={`bx-chip ${item.wanted ? "on" : ""}`}
                    disabled={wantBusy}
                    onClick={() => onToggleWant(item)}
                  >
                    {item.wanted ? <BookmarkCheckIcon aria-hidden="true" /> : <BookmarkPlusIcon aria-hidden="true" />}
                    {item.wanted ? "Wanted" : "Want"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {canCreate && d ? (
              <div className="bx-detail-makes">
                {d.dex ? (
                  <button type="button" className="bx-chip" disabled={!!busy} onClick={() => void makeBinder("pokemon")}>
                    {busy === "pokemon" ? "Making" : `Make a binder for ${baseSpeciesName(d.name)}`}
                  </button>
                ) : null}
                {d.set.id ? (
                  <button type="button" className="bx-chip" disabled={!!busy} onClick={() => void makeBinder("set")}>
                    {busy === "set" ? "Making" : `Make a binder of ${d.set.name}`}
                  </button>
                ) : null}
              </div>
            ) : null}
            {error ? <p className="bx-error mt-3 text-[14px]">{error}</p> : null}
            <p className="bx-detail-count tnum">
              {index + 1} of {items.length}
            </p>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
