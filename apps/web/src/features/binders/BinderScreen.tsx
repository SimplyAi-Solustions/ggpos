import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  BookmarkPlusIcon,
  CheckIcon,
  CircleDashedIcon,
  FilePlusIcon,
  FileXIcon,
  MoonIcon,
  MoveIcon,
  PlusIcon,
  Redo2Icon,
  Settings2Icon,
  Share2Icon,
  SunIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react"

import { PageTitle } from "@/components/ui/page-title"
import { LoadFailed } from "@/features/portal/LoadFailed"
import {
  cancelWanted,
  colorOf,
  getBinder,
  KINDS,
  listPockets,
  listWanted,
  saveLayout,
  updateBinder,
  wantCard,
  type Binder,
  type BinderCard,
  type WantedRequest,
} from "@/features/binders/api"
import {
  addPage,
  binderStats,
  buildPages,
  clearPockets,
  commit,
  diffLayouts,
  gridOf,
  GRIDS,
  initHistory,
  isEmptyDiff,
  layoutFrom,
  movePage,
  movePockets,
  pageCount,
  redo,
  reflowPage,
  removePage,
  setOwned,
  undo,
  type Filter,
  type Grid,
  type History,
  type Layout,
} from "@/features/binders/layout"
import { BookView } from "@/features/binders/BookView"
import { EmptyPocket, Pocket } from "@/features/binders/Pocket"
import { FilterTabs, GridSwitch, PageNav, StatTiles } from "@/features/binders/BinderParts"
import { AddCardSheet, SettingsSheet, ShareSheet } from "@/features/binders/BinderSheets"
import { useBinderTheme, usePrefersReducedMotion, useWide } from "@/features/binders/theme"
import "@/features/binders/binders.css"

const SAVE_FAILED = "Could not save that change. Check your connection; the binder has been reloaded as it was last saved."

export function BinderScreen({ id }: { id: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [theme, toggleTheme] = useBinderTheme()
  const reduced = usePrefersReducedMotion()
  const wide = useWide()

  const binderKey = React.useMemo(() => ["portal", "binder", id] as const, [id])
  const binderQ = useQuery({ queryKey: binderKey, queryFn: () => getBinder(id) })
  const cardsQ = useQuery({
    queryKey: ["portal", "binder-cards", id],
    queryFn: () => listPockets(id),
    refetchOnWindowFocus: false,
  })
  const wantedQ = useQuery({ queryKey: ["portal", "binder-wanted"], queryFn: listWanted })

  // The layout history is rebuilt whenever a fresh copy of the pockets
  // arrives from the server (first load, after adding a card, after a failed
  // save). Between those, it is the truth the screen draws from.
  const [hist, setHist] = React.useState<History | null>(null)
  const [histFor, setHistFor] = React.useState<BinderCard[] | null>(null)
  if (cardsQ.data && binderQ.data && histFor !== cardsQ.data) {
    setHistFor(cardsQ.data)
    setHist(initHistory(layoutFrom(cardsQ.data, binderQ.data.min_slots)))
  }

  const [filter, setFilter] = React.useState<Filter>("all")
  const [page, setPage] = React.useState(0)
  const [selecting, setSelecting] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>([])
  const [moving, setMoving] = React.useState(false)
  const [editPages, setEditPages] = React.useState(false)
  const [just, setJust] = React.useState("")
  const [status, setStatus] = React.useState("")
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(0)
  const [wantBusy, setWantBusy] = React.useState("")
  const [sheet, setSheet] = React.useState<null | "add" | "settings" | "share">(null)
  const [addSlot, setAddSlot] = React.useState<number | undefined>(undefined)
  const [sheetRun, setSheetRun] = React.useState(0)
  const saveChain = React.useRef<Promise<void>>(Promise.resolve())

  const b = binderQ.data
  const grid = gridOf(b?.grid)
  const cols = GRIDS[grid].cols
  const rows = GRIDS[grid].rows
  const color = colorOf(b?.color ?? "volt")
  const all = React.useMemo(() => cardsQ.data ?? [], [cardsQ.data])
  const layout = hist?.present ?? null
  const byId = React.useMemo(() => new Map(all.map((c) => [c.id, c])), [all])

  const pages = React.useMemo(
    () => (layout ? buildPages(all, layout, grid, filter) : []),
    [all, layout, grid, filter]
  )
  const count = Math.max(1, pages.length)
  const spread = wide
  const step = spread ? 2 : 1
  const clamped = Math.min(page, count - 1)
  const current = spread ? clamped - (clamped % 2) : clamped

  const stats = React.useMemo(
    () => (layout ? binderStats(all, layout, b?.kind ?? "custom") : null),
    [all, layout, b?.kind]
  )
  const counts = React.useMemo(() => {
    let owned = 0
    let total = 0
    if (layout) {
      for (const c of all) {
        if ((layout.slots[c.id] ?? -1) < 0) continue
        total++
        if (layout.owned[c.id]) owned++
      }
    }
    return { all: total, owned, needed: total - owned }
  }, [all, layout])

  const wantedByCard = React.useMemo(() => {
    const m = new Map<string, WantedRequest>()
    for (const w of wantedQ.data ?? []) m.set(w.card_id, w)
    return m
  }, [wantedQ.data])
  const wantedHere = React.useMemo(
    () =>
      layout
        ? all.filter((c) => (layout.slots[c.id] ?? -1) >= 0 && !layout.owned[c.id] && wantedByCard.has(c.card_id)).length
        : 0,
    [all, layout, wantedByCard]
  )

  function refreshShelf() {
    void queryClient.invalidateQueries({ queryKey: ["portal", "binders"] })
    void queryClient.invalidateQueries({ queryKey: ["portal", "binder-pockets"] })
  }

  function persist(prev: Layout, next: Layout) {
    const diff = diffLayouts(prev, next)
    if (isEmptyDiff(diff)) return
    setSaving((n) => n + 1)
    saveChain.current = saveChain.current
      .then(() => saveLayout(id, diff))
      .then(
        () => refreshShelf(),
        () => {
          setError(SAVE_FAILED)
          void cardsQ.refetch()
        }
      )
      .finally(() => setSaving((n) => n - 1))
  }

  function apply(next: Layout, message = "") {
    if (!hist || next === hist.present) return
    setError("")
    setStatus(message)
    setHist(commit(hist, next))
    persist(hist.present, next)
  }

  function doUndo() {
    if (!hist?.past.length) return
    const h = undo(hist)
    setHist(h)
    setStatus("Undone.")
    persist(hist.present, h.present)
  }

  function doRedo() {
    if (!hist?.future.length) return
    const h = redo(hist)
    setHist(h)
    setStatus("Redone.")
    persist(hist.present, h.present)
  }

  // Keyboard: arrows turn pages, Ctrl or Cmd Z undoes, with Shift redoes.
  const keyRef = React.useRef({ doUndo, doRedo, turn: (d: 1 | -1) => turnPage(d) })
  React.useEffect(() => {
    keyRef.current = { doUndo, doRedo, turn: (d: 1 | -1) => turnPage(d) }
  })
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (document.querySelector("[role=dialog]")) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) keyRef.current.doRedo()
        else keyRef.current.doUndo()
      } else if (e.key === "ArrowRight") keyRef.current.turn(1)
      else if (e.key === "ArrowLeft") keyRef.current.turn(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function turnPage(dir: 1 | -1) {
    const next = current + dir * step
    if (next < 0 || next > count - 1) return
    setPage(next)
  }

  function changeGrid(g: Grid) {
    if (!b || g === grid) return
    setPage(reflowPage(current, grid, g))
    queryClient.setQueryData<Binder>(binderKey, { ...b, grid: g })
    updateBinder(b.id, { grid: g }).catch(() => {
      queryClient.setQueryData<Binder>(binderKey, b)
      setError("Could not change the page size. Check your connection and try again.")
    })
  }

  function changeFilter(f: Filter) {
    setFilter(f)
    setPage(0)
    setMoving(false)
  }

  function stopSelecting() {
    setSelecting(false)
    setSelected([])
    setMoving(false)
  }

  function tapPocket(c: BinderCard) {
    if (!layout) return
    if (moving) return moveTo(layout.slots[c.id])
    if (selecting) {
      setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))
      return
    }
    const owned = !layout.owned[c.id]
    apply(setOwned(layout, [c.id], owned), owned ? `${c.name} collected.` : `${c.name} marked needed.`)
    if (owned) {
      setJust(c.id)
      setTimeout(() => setJust((j) => (j === c.id ? "" : j)), 1100)
    }
  }

  function moveTo(slot: number) {
    if (!layout || slot < 0) return
    const n = selected.length
    apply(movePockets(layout, selected, slot), `${n} ${n === 1 ? "card" : "cards"} moved.`)
    setMoving(false)
    setSelected([])
    setSelecting(false)
  }

  function tapEmpty(slot: number) {
    if (moving) return moveTo(slot)
    if (selecting || filter !== "all" || slot < 0) return
    setAddSlot(slot)
    setSheetRun((n) => n + 1)
    setSheet("add")
  }

  function bulkOwned(owned: boolean) {
    if (!layout || !selected.length) return
    const n = selected.length
    apply(
      setOwned(layout, selected, owned),
      `${n} ${n === 1 ? "card" : "cards"} marked ${owned ? "collected" : "needed"}.`
    )
    stopSelecting()
  }

  function bulkClear() {
    if (!layout || !selected.length) return
    const n = selected.length
    apply(clearPockets(layout, selected), `${n} ${n === 1 ? "card" : "cards"} taken out. Undo puts them back.`)
    stopSelecting()
  }

  async function toggleWant(c: BinderCard) {
    const open = wantedByCard.get(c.card_id)
    setWantBusy(c.id)
    setError("")
    try {
      if (open) await cancelWanted(open.id)
      else await wantCard(c.id)
      await wantedQ.refetch()
      setStatus(open ? `You are no longer asking for ${c.name}.` : `The shop can now see you want ${c.name}.`)
    } catch {
      setError(`Could not update ${c.name}. Check your connection and try again.`)
    }
    setWantBusy("")
  }

  async function bulkWant() {
    if (!layout) return
    const list = selected
      .map((sid) => byId.get(sid))
      .filter((c): c is BinderCard => !!c && !layout.owned[c.id] && !wantedByCard.has(c.card_id))
    if (!list.length) {
      setStatus("Those cards are collected or already asked for.")
      stopSelecting()
      return
    }
    setWantBusy("bulk")
    let done = 0
    for (const c of list) {
      try {
        await wantCard(c.id)
        done++
      } catch {
        // Carry on with the rest; the count below says how many went through.
      }
    }
    await wantedQ.refetch()
    setWantBusy("")
    stopSelecting()
    if (done === list.length) setStatus(`The shop can now see you want ${done} ${done === 1 ? "card" : "cards"}.`)
    else setError(`Only ${done} of ${list.length} went through. Check your connection and try the rest again.`)
  }

  function pageOp(kind: "insert" | "remove" | "earlier" | "later", p: number) {
    if (!layout) return
    if (kind === "insert") {
      apply(addPage(layout, grid, p + 1), `Empty page added after page ${p + 1}.`)
    } else if (kind === "remove") {
      apply(removePage(layout, grid, p), `Page ${p + 1} removed. Undo puts it back.`)
    } else if (kind === "earlier" && p > 0) {
      apply(movePage(layout, grid, p, p - 1), `Page ${p + 1} is now page ${p}.`)
      setPage(p - 1)
    } else if (kind === "later" && p < count - 1) {
      apply(movePage(layout, grid, p, p + 1), `Page ${p + 1} is now page ${p + 2}.`)
      setPage(p + 1)
    }
  }

  function addPageAtEnd() {
    if (!layout) return
    const n = pageCount(layout, grid)
    apply(addPage(layout, grid), `Page ${n + 1} added.`)
    setPage(n)
  }

  if (binderQ.isError || cardsQ.isError) {
    return (
      <LoadFailed
        title="Binder"
        error={binderQ.error ?? cardsQ.error}
        fallback="This binder did not load. It may have been deleted. Go back to your binders and try again."
        onRetry={() => {
          void binderQ.refetch()
          void cardsQ.refetch()
        }}
      />
    )
  }

  const canEditPages = filter === "all" && !selecting
  const compact = grid === "4x4" || (!wide && grid === "3x4")

  function renderPage(i: number, live: boolean) {
    const cells = pages[i] ?? []
    return (
      <div className="bx-page" style={{ "--cols": cols, "--rows": rows } as React.CSSProperties}>
        <div className="bx-grid">
          {cells.map((cell, ci) => {
            const c = cell.pocket ? byId.get(cell.pocket.id) : undefined
            if (!c || !layout) {
              return (
                <EmptyPocket
                  key={`e${i}-${ci}`}
                  label={cell.slot >= 0 ? `pocket ${(cell.slot % (cols * rows)) + 1} on page ${i + 1}` : undefined}
                  target={live && moving && cell.slot >= 0}
                  onTarget={live ? () => tapEmpty(cell.slot) : undefined}
                  onAdd={live && filter === "all" && !selecting && cell.slot >= 0 ? () => tapEmpty(cell.slot) : undefined}
                />
              )
            }
            return (
              <Pocket
                key={c.id}
                c={c}
                owned={!!layout.owned[c.id]}
                just={just === c.id}
                selecting={selecting}
                selected={selected.includes(c.id)}
                target={live && moving}
                wanted={wantedByCard.has(c.card_id)}
                wantBusy={wantBusy === c.id || wantBusy === "bulk"}
                compact={compact}
                onTap={live ? () => tapPocket(c) : undefined}
                onWant={live ? () => void toggleWant(c) : undefined}
              />
            )
          })}
        </div>
        <div className="bx-page-foot">
          <span className="bx-page-no">PAGE {i + 1}</span>
          {live && editPages && canEditPages ? (
            <span className="bx-page-tools">
              <button type="button" onClick={() => pageOp("earlier", i)} disabled={i === 0} aria-label={`Move page ${i + 1} earlier`}>
                <ChevronsLeftIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => pageOp("later", i)}
                disabled={i >= count - 1}
                aria-label={`Move page ${i + 1} later`}
              >
                <ChevronsRightIcon aria-hidden="true" />
              </button>
              <button type="button" onClick={() => pageOp("insert", i)} aria-label={`Add an empty page after page ${i + 1}`}>
                <FilePlusIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => pageOp("remove", i)}
                disabled={count <= 1}
                aria-label={`Remove page ${i + 1}`}
              >
                <FileXIcon aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  const subtitle = b
    ? [b.owner ? `${b.owner}'s binder` : "", KINDS[b.kind], b.query_label && b.query_label !== b.name ? b.query_label : ""]
        .filter(Boolean)
        .join(", ")
    : ""

  return (
    <div className="bx-root bx-screen pt-8 sm:pt-14" style={{ "--bc": color } as React.CSSProperties}>
      <div className="bx-topbar">
        <Link to="/account/binders" className="bx-back">
          <ArrowLeftIcon aria-hidden="true" className="size-4 stroke-[1.25]" />
          All binders
        </Link>
        <span className="flex-1" />
        <button type="button" className="bx-icon" onClick={toggleTheme} aria-label={theme === "dark" ? "Light pages" : "Dark pages"}>
          {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="bx-icon"
          disabled={!b}
          onClick={() => {
            setSheetRun((n) => n + 1)
            setSheet("share")
          }}
          aria-label="Share this binder"
        >
          <Share2Icon aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bx-icon"
          disabled={!b}
          onClick={() => {
            setSheetRun((n) => n + 1)
            setSheet("settings")
          }}
          aria-label="Binder settings"
        >
          <Settings2Icon aria-hidden="true" />
        </button>
      </div>

      <PageTitle className="mt-5 bx-title-main">{b?.name ?? "Binder"}</PageTitle>
      {subtitle ? <p className="bx-sub">{subtitle}</p> : null}

      {stats ? (
        <StatTiles
          stats={stats}
          kind={b?.kind ?? "custom"}
          color={color}
          pages={layout ? pageCount(layout, grid) : 1}
          grid={grid}
          wanted={wantedHere}
        />
      ) : (
        <div className="bx-skel mt-6" style={{ height: 96 }} />
      )}

      <div className="bx-controls">
        <FilterTabs filter={filter} counts={counts} onChange={changeFilter} />
        <GridSwitch grid={grid} onChange={changeGrid} />
        <div className="bx-tools">
          <button
            type="button"
            className={`bx-chip ${selecting ? "on" : ""}`}
            aria-pressed={selecting}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
          >
            <CheckIcon aria-hidden="true" />
            Select
          </button>
          <button
            type="button"
            className={`bx-chip ${editPages ? "on" : ""}`}
            aria-pressed={editPages}
            disabled={filter !== "all"}
            onClick={() => setEditPages((v) => !v)}
          >
            <ArrowLeftRightIcon aria-hidden="true" />
            Pages
          </button>
          <button type="button" className="bx-icon" onClick={doUndo} disabled={!hist?.past.length} aria-label="Undo">
            <Undo2Icon aria-hidden="true" />
          </button>
          <button type="button" className="bx-icon" onClick={doRedo} disabled={!hist?.future.length} aria-label="Redo">
            <Redo2Icon aria-hidden="true" />
          </button>
          <span className="bx-saving" aria-live="polite">
            {saving ? "Saving" : ""}
          </span>
        </div>
      </div>

      <div className="bx-status" aria-live="polite">
        {error ? (
          <p className="bx-error" role="alert">
            {error}
          </p>
        ) : status ? (
          <p>{status}</p>
        ) : null}
      </div>

      {moving ? (
        <div className="bx-banner" role="status">
          <MoveIcon aria-hidden="true" />
          <span>Tap the pocket where the first chosen card should go. Turn the page to move them further.</span>
          <button type="button" onClick={() => setMoving(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      {!layout ? (
        <div className="bx-skel mt-6" style={{ aspectRatio: spread ? "1.45" : "0.78" }} />
      ) : (
        <BookView count={count} page={current} spread={spread} reduced={reduced} onSwipe={turnPage} renderPage={renderPage} />
      )}
      {layout && !counts.all && filter === "all" ? (
        <p className="bx-hint">This binder is empty. Tap a pocket to add the first card.</p>
      ) : null}

      {layout ? (
        <PageNav page={current} count={count} step={step} onPage={(p) => setPage(spread ? p - (p % 2) : p)}>
          {filter === "all" && !selecting ? (
            <button type="button" className="bx-chip" onClick={addPageAtEnd}>
              <PlusIcon aria-hidden="true" />
              Add page
            </button>
          ) : null}
        </PageNav>
      ) : null}

      <AnimatePresence>
        {selecting ? (
          <motion.div
            className="bx-actionbar"
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }}
            role="toolbar"
            aria-label="Chosen cards"
          >
            <div className="bx-actionbar-count tnum">
              {selected.length ? `${selected.length} chosen` : "Tap cards to choose them"}
            </div>
            <div className="bx-actionbar-btns">
              <button type="button" disabled={!selected.length} onClick={() => bulkOwned(true)}>
                <CheckIcon aria-hidden="true" />
                <span>Owned</span>
              </button>
              <button type="button" disabled={!selected.length} onClick={() => bulkOwned(false)}>
                <CircleDashedIcon aria-hidden="true" />
                <span>Needed</span>
              </button>
              <button type="button" disabled={!selected.length || !!wantBusy} onClick={() => void bulkWant()}>
                <BookmarkPlusIcon aria-hidden="true" />
                <span>Want</span>
              </button>
              <button
                type="button"
                disabled={!selected.length || filter !== "all"}
                className={moving ? "on" : ""}
                onClick={() => setMoving((m) => !m)}
              >
                <MoveIcon aria-hidden="true" />
                <span>Move</span>
              </button>
              <button type="button" disabled={!selected.length} onClick={bulkClear}>
                <Trash2Icon aria-hidden="true" />
                <span>Clear</span>
              </button>
              <button type="button" onClick={stopSelecting} aria-label="Stop choosing">
                <XIcon aria-hidden="true" />
                <span>Done</span>
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {b ? (
        <>
          <AddCardSheet
            key={`add-${sheetRun}`}
            open={sheet === "add"}
            onOpenChange={(o) => setSheet(o ? "add" : null)}
            binder={b}
            slot={addSlot}
            onAdded={() => {
              void cardsQ.refetch()
              refreshShelf()
            }}
          />
          <SettingsSheet
            key={`settings-${sheetRun}`}
            open={sheet === "settings"}
            onOpenChange={(o) => setSheet(o ? "settings" : null)}
            binder={b}
            onSaved={() => {
              void binderQ.refetch()
              refreshShelf()
            }}
            onDeleted={() => {
              refreshShelf()
              void navigate({ to: "/account/binders" })
            }}
          />
          <ShareSheet
            key={`share-${sheetRun}`}
            open={sheet === "share"}
            onOpenChange={(o) => setSheet(o ? "share" : null)}
            binder={b}
            onChanged={(token) => queryClient.setQueryData<Binder>(binderKey, { ...b, share_token: token })}
          />
        </>
      ) : null}
    </div>
  )
}
