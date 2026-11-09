import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { MoonIcon, SunIcon } from "lucide-react"

import { Wordmark } from "@/components/ui/wordmark"
import { colorOf, getShared, KINDS } from "@/features/binders/api"
import { binderStats, buildPages, gridOf, GRIDS, layoutFrom, pageCount, reflowPage, type Filter, type Grid } from "@/features/binders/layout"
import { BookView } from "@/features/binders/BookView"
import { EmptyPocket, Pocket } from "@/features/binders/Pocket"
import { FilterTabs, GridSwitch, PageNav, StatTiles } from "@/features/binders/BinderParts"
import { useBinderTheme, usePrefersReducedMotion, useWide } from "@/features/binders/theme"
import "@/features/binders/binders.css"

/**
 * A binder someone shared: read only, no sign-in. It shows what the binder
 * is and which pockets are filled, never who owns it and never a value. The
 * visitor can change the page size and the filter for themselves; nothing is
 * saved.
 */
export function SharedBinderScreen({ token }: { token: string }) {
  const [theme, toggleTheme] = useBinderTheme()
  const reduced = usePrefersReducedMotion()
  const wide = useWide()
  const q = useQuery({ queryKey: ["binder-share", token], queryFn: () => getShared(token), retry: 1 })
  const [gridChoice, setGridChoice] = React.useState<Grid | null>(null)
  const [filter, setFilter] = React.useState<Filter>("all")
  const [page, setPage] = React.useState(0)

  const data = q.data
  const grid = gridChoice ?? gridOf(data?.binder.grid)
  const layout = React.useMemo(
    () => (data ? layoutFrom(data.pockets, data.binder.min_slots) : null),
    [data]
  )
  const pockets = React.useMemo(() => data?.pockets ?? [], [data])
  const byId = React.useMemo(() => new Map(pockets.map((p) => [p.id, p])), [pockets])
  // The share payload carries in_stock true on needed pockets the shop has;
  // a boolean is all it ever is - no price here either.
  const inStock = React.useMemo(
    () => new Set(pockets.filter((p) => p.in_stock).map((p) => p.id)),
    [pockets]
  )
  const pages = React.useMemo(
    () => (layout ? buildPages(pockets, layout, grid, filter, inStock) : []),
    [pockets, layout, grid, filter, inStock]
  )
  const stats = React.useMemo(
    () => (layout && data ? binderStats(pockets, layout, data.binder.kind) : null),
    [pockets, layout, data]
  )
  const count = Math.max(1, pages.length)
  const step = wide ? 2 : 1
  const clamped = Math.min(page, count - 1)
  const current = wide ? clamped - (clamped % 2) : clamped
  const color = colorOf(data?.binder.color ?? "volt")
  const { cols, rows } = GRIDS[grid]
  const compact = grid === "4x4" || (!wide && grid === "3x4")
  const owned = stats?.filled ?? 0
  const total = stats?.total ?? 0

  function turn(dir: 1 | -1) {
    const next = current + dir * step
    if (next >= 0 && next <= count - 1) setPage(next)
  }

  function renderPage(i: number) {
    const cells = pages[i] ?? []
    return (
      <div className="bx-page" style={{ "--cols": cols, "--rows": rows } as React.CSSProperties}>
        <div className="bx-grid">
          {cells.map((cell, ci) => {
            const c = cell.pocket ? byId.get(cell.pocket.id) : undefined
            return c && layout ? (
              <Pocket key={c.id} c={c} owned={!!layout.owned[c.id]} compact={compact} inStock={inStock.has(c.id)} />
            ) : (
              <EmptyPocket key={`e${i}-${ci}`} />
            )
          })}
        </div>
        <div className="bx-page-foot">
          <span className="bx-page-no">PAGE {i + 1}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="bx-root bx-screen bx-shared mx-auto w-full max-w-[1180px] px-5 pt-6 pb-24 sm:px-8">
      <div className="bx-topbar">
        <Link to="/account" className="bx-back" aria-label="GG Vault">
          <Wordmark />
        </Link>
        <span className="flex-1" />
        <button type="button" className="bx-icon" onClick={toggleTheme} aria-label={theme === "dark" ? "Light pages" : "Dark pages"}>
          {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </button>
      </div>

      {q.isError ? (
        <div className="mt-16 grid gap-4">
          <h1 className="bx-title-main font-display text-[40px] leading-none uppercase">Binder not found</h1>
          <p className="bx-sub">{(q.error as Error).message}</p>
        </div>
      ) : !data || !layout || !stats ? (
        <div className="mt-10 grid gap-6">
          <div className="bx-skel" style={{ height: 48, width: "60%" }} />
          <div className="bx-skel" style={{ aspectRatio: wide ? "1.45" : "0.78" }} />
        </div>
      ) : (
        <div style={{ "--bc": color } as React.CSSProperties}>
          <p className="bx-kicker">Shared binder</p>
          <h1 className="bx-title-main font-display text-[44px] leading-[0.95] uppercase sm:text-[64px]">{data.binder.name}</h1>
          <p className="bx-sub">
            {[KINDS[data.binder.kind as keyof typeof KINDS], data.binder.query_label !== data.binder.name ? data.binder.query_label : ""]
              .filter(Boolean)
              .join(", ")}
          </p>
          <StatTiles
            stats={stats}
            kind={data.binder.kind}
            color={color}
            pages={pageCount(layout, grid)}
            grid={grid}
            inShop={inStock.size}
          />
          <div className="bx-controls">
            <FilterTabs
              filter={filter}
              counts={{ all: total, owned, needed: total - owned, instock: inStock.size }}
              onChange={(f) => {
                setFilter(f)
                setPage(0)
              }}
            />
            <GridSwitch
              grid={grid}
              onChange={(g) => {
                setPage(reflowPage(current, grid, g))
                setGridChoice(g)
              }}
            />
          </div>
          <BookView count={count} page={current} spread={wide} reduced={reduced} onSwipe={turn} renderPage={renderPage} />
          <PageNav page={current} count={count} step={step} onPage={(p) => setPage(wide ? p - (p % 2) : p)} />
          <p className="bx-foot-note">
            Made with GG Vault at GG Entertainment, Bolsover. Build your own binder from My Vault.
          </p>
        </div>
      )}
    </div>
  )
}
