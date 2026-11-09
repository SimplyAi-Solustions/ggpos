import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon, CheckIcon, LayersIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import {
  addCard,
  colorOf,
  COLORS,
  deleteBinder,
  getBinder,
  img,
  KINDS,
  listPockets,
  packPages,
  searchCards,
  setOwned,
  statsFor,
  updateBinder,
  type Binder,
  type BinderCard,
  type SearchHit,
} from "@/features/binders/api"
import "@/features/binders/binders.css"

/** Pointer tilt for a card in its sleeve. Touch skips it; a tap is a tick, not a tilt. */
function tiltMove(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget.querySelector<HTMLElement>(".bx-art")
  if (!el || e.pointerType === "touch") return
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  el.style.setProperty("--ry", `${(x - 0.5) * 16}deg`)
  el.style.setProperty("--rx", `${(0.5 - y) * 16}deg`)
  el.style.setProperty("--gx", `${x * 100}%`)
  el.style.setProperty("--gy", `${y * 100}%`)
}

function tiltLeave(e: React.PointerEvent<HTMLElement>) {
  const el = e.currentTarget.querySelector<HTMLElement>(".bx-art")
  if (el) {
    el.style.setProperty("--rx", "0deg")
    el.style.setProperty("--ry", "0deg")
  }
}

function BlankPocket() {
  return (
    <div className="bx-pocket blank" aria-hidden="true">
      <div className="bx-sleeve">
        <div className="bx-art" />
      </div>
      <div className="bx-cap">
        <div className="n">&nbsp;</div>
        <div className="s">&nbsp;</div>
      </div>
    </div>
  )
}

function Pocket({ c, just, onToggle }: { c: BinderCard; just: boolean; onToggle: (c: BinderCard) => void }) {
  const [broken, setBroken] = React.useState(false)
  const total = c.set_total && /^\d+$/.test(c.number) ? `/${c.set_total}` : ""
  return (
    <div className={`bx-pocket ${c.owned ? "got" : ""} ${just ? "just" : ""}`}>
      <button
        type="button"
        className="bx-sleeve"
        onClick={() => onToggle(c)}
        onPointerMove={tiltMove}
        onPointerLeave={tiltLeave}
        aria-pressed={c.owned}
        aria-label={`${c.name} ${c.number}${total}. ${c.owned ? "Collected. Tap to take it out." : "Missing. Tap to mark it collected."}`}
      >
        <div className="bx-art">
          {c.image && !broken ? (
            <img src={img(c.image)} alt="" loading="lazy" onError={() => setBroken(true)} />
          ) : (
            <div className="bx-art-empty">
              <LayersIcon size={18} />
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
          {c.owned ? (
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
      </button>
      <div className="bx-cap">
        <div className="n">{c.name}</div>
        <div className="s">
          {c.number}
          {total} {c.set_name}
        </div>
      </div>
    </div>
  )
}

function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <div className="bx-ring">
      <svg viewBox="0 0 74 74" aria-hidden="true">
        <circle cx="37" cy="37" r={r} fill="none" stroke="var(--hairline-soft)" strokeWidth="6" />
        <motion.circle
          cx="37"
          cy="37"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <b className="tnum">{Math.round(pct * 100)}%</b>
    </div>
  )
}

function AddCardSheet({
  open,
  onOpenChange,
  binder,
  onAdded,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  binder: Binder
  onAdded: () => void
}) {
  const [q, setQ] = React.useState("")
  const [term, setTerm] = React.useState("")
  const [adding, setAdding] = React.useState("")
  const [note, setNote] = React.useState("")

  // Wait for a pause in typing before asking the catalogue.
  React.useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(timer)
  }, [q])

  const search = useQuery({
    queryKey: ["portal", "binder-search", term],
    queryFn: () => searchCards(term),
    enabled: term.length >= 2,
    staleTime: 60_000,
  })
  const hits = term.length >= 2 ? (search.data ?? []) : []
  const busy = term.length >= 2 && search.isFetching

  async function add(c: SearchHit) {
    setAdding(c.card_id)
    try {
      const r = await addCard(binder.id, c.card_id)
      setNote(r.existed ? `${c.name} is already in this binder.` : `${c.name} added.`)
      onAdded()
    } catch {
      setNote(`Could not add ${c.name}. Try again.`)
    }
    setAdding("")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>Add a card</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          <input
            className="bx-search"
            autoFocus
            aria-label="Card name"
            placeholder="Card name, for example Pikachu"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {note ? (
            <p className="mt-3 text-[15px] text-muted-foreground" role="status">
              {note}
            </p>
          ) : null}
          <div className="bx-hits">
            {busy && !hits.length
              ? [0, 1, 2].map((i) => <div key={i} className="bx-skel" style={{ aspectRatio: "0.716" }} />)
              : null}
            {hits.map((c) => (
              <button key={c.card_id} type="button" className="bx-hit" disabled={!!adding} onClick={() => void add(c)}>
                {c.image ? <img src={img(c.image)} alt="" loading="lazy" /> : <span className="ph" />}
                <b>{c.name}</b>
                <small>
                  {adding === c.card_id ? "Adding" : `${c.set_name}, ${c.number}`}
                </small>
              </button>
            ))}
          </div>
          {!busy && q.trim().length >= 2 && !hits.length ? (
            <p className="mt-3 text-[15px] text-muted-foreground">No cards match {q}. Check the spelling.</p>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function SettingsSheet({
  open,
  onOpenChange,
  binder,
  onSaved,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  binder: Binder
  onSaved: () => void
  onDeleted: () => void
}) {
  const [name, setName] = React.useState(binder.name)
  const [owner, setOwner] = React.useState(binder.owner)
  const [color, setColor] = React.useState(binder.color)
  const [confirm, setConfirm] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  async function save() {
    setBusy(true)
    try {
      await updateBinder(binder.id, { name: name.trim(), owner: owner.trim(), color })
      onSaved()
      onOpenChange(false)
    } catch {
      setError("Could not save the binder. Try again.")
    }
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteBinder(binder.id)
      onOpenChange(false)
      onDeleted()
    } catch {
      setError("Could not delete the binder. Try again.")
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>Binder settings</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          <div className="grid gap-8">
            <label className="grid gap-1.5">
              <MicroLabel>Name</MicroLabel>
              <input className="bx-search" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="grid gap-1.5">
              <MicroLabel>Who is it for</MicroLabel>
              <input className="bx-search" value={owner} maxLength={80} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <div className="grid gap-2">
              <MicroLabel>Cover colour</MicroLabel>
              <div className="bx-swatches">
                {COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-label={c.l}
                    aria-pressed={color === c.id}
                    className={`bx-swatch ${color === c.id ? "on" : ""}`}
                    style={{ "--c": c.c } as React.CSSProperties}
                    onClick={() => setColor(c.id)}
                  />
                ))}
              </div>
            </div>
            {error ? <p className="text-[15px] text-destructive">{error}</p> : null}
          </div>
        </SheetBody>
        <SheetFooter className={SHEET_COLUMN}>
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            {!confirm ? (
              <Button type="button" variant="text-destructive" disabled={busy} onClick={() => setConfirm(true)}>
                Delete binder
              </Button>
            ) : (
              <Button type="button" variant="text-destructive" disabled={busy} onClick={() => void remove()}>
                Delete {binder.name} for good
              </Button>
            )}
            <Button type="button" loading={busy} disabled={busy || !name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function BinderScreen({ id }: { id: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [filter, setFilter] = React.useState<"all" | "need" | "got">("all")
  const [adding, setAdding] = React.useState(false)
  const [settings, setSettings] = React.useState(false)
  const [just, setJust] = React.useState("")
  const [saveError, setSaveError] = React.useState("")
  // Bumped each time a sheet opens, so its form starts fresh.
  const [sheetRun, setSheetRun] = React.useState(0)
  const openAdd = () => {
    setSheetRun((n) => n + 1)
    setAdding(true)
  }
  const openSettings = () => {
    setSheetRun((n) => n + 1)
    setSettings(true)
  }

  const binder = useQuery({ queryKey: ["portal", "binder", id], queryFn: () => getBinder(id) })
  const cardsKey = ["portal", "binder-cards", id] as const
  const cards = useQuery({ queryKey: cardsKey, queryFn: () => listPockets(id) })

  const all = React.useMemo(() => cards.data ?? [], [cards.data])
  const stats = React.useMemo(() => statsFor(all), [all])
  const list = React.useMemo(
    () => all.filter((c) => filter === "all" || (filter === "got" ? c.owned : !c.owned)),
    [all, filter]
  )
  const grouped = all.some((c) => c.group_name)
  const pages = React.useMemo(() => {
    if (grouped && filter === "all") return packPages(list)
    const p: (BinderCard | null)[][] = []
    for (let i = 0; i < list.length; i += 9) p.push(list.slice(i, i + 9))
    return p
  }, [list, grouped, filter])

  function refreshShelf() {
    void queryClient.invalidateQueries({ queryKey: ["portal", "binders"] })
    void queryClient.invalidateQueries({ queryKey: ["portal", "binder-pockets"] })
  }

  async function toggle(c: BinderCard) {
    const owned = !c.owned
    setSaveError("")
    queryClient.setQueryData<BinderCard[]>(cardsKey, (cs) => cs?.map((x) => (x.id === c.id ? { ...x, owned } : x)))
    if (owned) {
      setJust(c.id)
      setTimeout(() => setJust((j) => (j === c.id ? "" : j)), 1100)
    }
    try {
      await setOwned(c.id, owned)
      refreshShelf()
    } catch {
      queryClient.setQueryData<BinderCard[]>(cardsKey, (cs) =>
        cs?.map((x) => (x.id === c.id ? { ...x, owned: !owned } : x))
      )
      setSaveError(`Could not save ${c.name}. Check your connection and tap it again.`)
    }
  }

  if (binder.isError) {
    return (
      <LoadFailed
        title="Binder"
        error={binder.error}
        fallback="This binder did not load. It may have been deleted. Go back to your binders and try again."
        onRetry={() => void binder.refetch()}
      />
    )
  }

  const b = binder.data
  const bc = colorOf(b?.color ?? "volt")
  const pct = stats.total ? stats.got / stats.total : 0

  return (
    <div className="bx-root pt-10 sm:pt-16" style={{ "--bc": bc } as React.CSSProperties}>
      <Link
        to="/account/binders"
        className="inline-flex min-h-12 items-center gap-2 font-mono text-[11px] font-bold tracking-[0.16em] uppercase"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4 stroke-[1.25]" />
        All binders
      </Link>

      <PageTitle className="mt-6">{b?.name ?? "Binder"}</PageTitle>
      {b ? (
        <p className="mt-3 text-base text-muted-foreground">
          {[b.owner ? `${b.owner}'s binder` : "", KINDS[b.kind], b.query_label !== b.name ? b.query_label : ""]
            .filter(Boolean)
            .join(", ")}
        </p>
      ) : null}

      <div className="bx-stats">
        <Ring pct={pct} color={bc} />
        <div>
          <MicroLabel>Collected</MicroLabel>
          <div className="font-display text-[28px] leading-none tnum">
            {stats.got} <span className="text-muted-foreground-2">/ {stats.total}</span>
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground-2">
            {stats.total - stats.got} to find
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-2">
        {(
          [
            ["all", `All ${stats.total}`],
            ["need", `Need ${stats.total - stats.got}`],
            ["got", `Got ${stats.got}`],
          ] as const
        ).map(([v, l]) => (
          <Button
            key={v}
            type="button"
            variant="text"
            aria-pressed={filter === v}
            className={filter === v ? "after:scale-x-100" : "text-muted-foreground-2"}
            onClick={() => setFilter(v)}
          >
            {l}
          </Button>
        ))}
        <span className="flex-1" />
        <Button type="button" variant="text" onClick={openAdd} disabled={!b}>
          <PlusIcon aria-hidden="true" />
          Add card
        </Button>
        <Button type="button" variant="text" onClick={openSettings} disabled={!b}>
          Settings
        </Button>
      </div>

      {saveError ? (
        <p className="mt-4 text-[15px] text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}

      {cards.isPending ? (
        <div className="bx-skel mt-6" style={{ height: 420 }} />
      ) : !list.length ? (
        <div className="mt-10 grid justify-items-start gap-6">
          <p className="text-base text-muted-foreground">
            {all.length ? "Nothing matches that filter." : "This binder is empty. Add the first card."}
          </p>
          {!all.length ? (
            <Button type="button" onClick={openAdd}>
              Add card
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="bx-pages-list">
          {pages.map((page, pi) => (
            <motion.div
              key={`${pi}-${filter}`}
              className="bx-page"
              style={{ "--bc": bc } as React.CSSProperties}
              initial={{ opacity: 0, y: 40, rotateX: 8 }}
              whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ type: "spring", stiffness: 90, damping: 18 }}
            >
              <div className="bx-grid9">
                {page.map((c, ci) =>
                  !c ? (
                    <BlankPocket key={`b${ci}`} />
                  ) : (
                    <Pocket key={c.id} c={c} just={just === c.id} onToggle={(x) => void toggle(x)} />
                  )
                )}
                {!grouped && pi === pages.length - 1 && page.length < 9 && filter === "all" ? (
                  <button type="button" className="bx-pocket-add" onClick={openAdd}>
                    <PlusIcon size={18} />
                    Add card
                  </button>
                ) : null}
              </div>
              <div className="bx-page-no">PAGE {pi + 1}</div>
            </motion.div>
          ))}
        </div>
      )}

      {b ? (
        <>
          <AddCardSheet
            key={`add-${sheetRun}`}
            open={adding}
            onOpenChange={setAdding}
            binder={b}
            onAdded={() => {
              void cards.refetch()
              refreshShelf()
            }}
          />
          <SettingsSheet
            key={`settings-${sheetRun}`}
            open={settings}
            onOpenChange={setSettings}
            binder={b}
            onSaved={() => {
              void binder.refetch()
              refreshShelf()
            }}
            onDeleted={() => {
              refreshShelf()
              void navigate({ to: "/account/binders" })
            }}
          />
        </>
      ) : null}
    </div>
  )
}
