import * as React from "react"
import { motion } from "motion/react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { GRID_ORDER, GRIDS, type BinderStatsV2, type Filter, type Grid } from "@/features/binders/layout"

function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <div className="bx-ring">
      <svg viewBox="0 0 74 74" aria-hidden="true">
        <circle cx="37" cy="37" r={r} fill="none" stroke="var(--bx-line)" strokeWidth="6" />
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

const pctOf = (got: number, total: number) => (total ? got / total : 0)

/** The stats tiles: pockets filled, set (or Pokédex) completion, in the shop, wanted cards and pages. */
export function StatTiles({
  stats,
  kind,
  color,
  pages,
  grid,
  wanted,
  inShop,
}: {
  stats: BinderStatsV2
  kind: string
  color: string
  pages: number
  grid: Grid
  wanted?: number
  /** How many needed cards the shop has on the shelf right now. */
  inShop?: number
}) {
  const filledPct = pctOf(stats.filled, stats.total)
  let completion: { label: string; value: string; note: string; pct: number }
  if (stats.mainSet) {
    const p = pctOf(stats.mainSet.got, stats.mainSet.total)
    completion = {
      label: "Set completion",
      value: `${Math.round(p * 100)}%`,
      note: `${stats.mainSet.got} of ${stats.mainSet.total} in the set`,
      pct: p,
    }
  } else if (kind === "pokedex") {
    completion = {
      label: "Pokédex",
      value: `${Math.round(filledPct * 100)}%`,
      note: `${stats.filled} of ${stats.total} caught`,
      pct: filledPct,
    }
  } else {
    const next = stats.sets.find((s) => s.got < s.total)
    completion = {
      label: "Sets complete",
      value: `${stats.setsComplete} / ${stats.sets.length}`,
      note: next ? `Closest: ${next.set_name}, ${next.got} of ${next.total}` : stats.sets.length ? "Every set done" : "No sets yet",
      pct: pctOf(stats.setsComplete, stats.sets.length),
    }
  }
  return (
    <div className="bx-tiles">
      <div className="bx-tile wide">
        <Ring pct={filledPct} color={color} />
        <div>
          <div className="bx-tile-label">Pockets filled</div>
          <div className="bx-tile-value tnum">
            {stats.filled} <span>/ {stats.total}</span>
          </div>
          <div className="bx-tile-note">{stats.total - stats.filled} to find</div>
        </div>
      </div>
      <div className="bx-tile">
        <div className="bx-tile-label">{completion.label}</div>
        <div className="bx-tile-value tnum">{completion.value}</div>
        <div className="bx-tile-bar">
          <i style={{ width: `${Math.max(completion.pct ? 3 : 0, completion.pct * 100)}%` }} />
        </div>
        <div className="bx-tile-note">{completion.note}</div>
      </div>
      {inShop !== undefined ? (
        <div className="bx-tile bx-tile-instock">
          <div className="bx-tile-label">In stock at GG</div>
          <div className="bx-tile-value tnum">{inShop}</div>
          <div className="bx-tile-note">
            {inShop === 1 ? "Needed card in the shop" : "Needed cards in the shop"}
          </div>
        </div>
      ) : null}
      {wanted !== undefined ? (
        <div className="bx-tile">
          <div className="bx-tile-label">Wanted</div>
          <div className="bx-tile-value tnum">{wanted}</div>
          <div className="bx-tile-note">Asked for at the shop</div>
        </div>
      ) : null}
      <div className="bx-tile">
        <div className="bx-tile-label">Pages</div>
        <div className="bx-tile-value tnum">{pages}</div>
        <div className="bx-tile-note">{GRIDS[grid].label} pages</div>
      </div>
    </div>
  )
}

export function GridSwitch({ grid, onChange }: { grid: Grid; onChange: (g: Grid) => void }) {
  return (
    <div className="bx-seg" role="group" aria-label="Pockets per page">
      {GRID_ORDER.map((g) => (
        <button
          key={g}
          type="button"
          aria-pressed={grid === g}
          aria-label={`${GRIDS[g].label} pages, ${g.replace("x", " by ")}`}
          className={grid === g ? "on" : ""}
          onClick={() => onChange(g)}
        >
          <span
            className="bx-gridicon"
            style={{ "--c": GRIDS[g].cols, "--r": GRIDS[g].rows } as React.CSSProperties}
            aria-hidden="true"
          >
            {Array.from({ length: GRIDS[g].cols * GRIDS[g].rows }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="t">{g}</span>
        </button>
      ))}
    </div>
  )
}

export function FilterTabs({
  filter,
  counts,
  onChange,
}: {
  filter: Filter
  counts: { all: number; owned: number; needed: number; instock?: number }
  onChange: (f: Filter) => void
}) {
  const tabs: [Filter, string][] = [
    ["all", `All ${counts.all}`],
    ["owned", `Owned ${counts.owned}`],
    ["needed", `Needed ${counts.needed}`],
  ]
  if (counts.instock !== undefined) tabs.push(["instock", `In stock at GG ${counts.instock}`])
  return (
    <div className="bx-seg bx-filter" role="group" aria-label="Show">
      {tabs.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={filter === v} className={filter === v ? "on" : ""} onClick={() => onChange(v)}>
          <span className="t">{l}</span>
        </button>
      ))}
    </div>
  )
}

/** Page arrows, "Page 3 of 12", and a slider to jump through a long binder. */
export function PageNav({
  page,
  count,
  step,
  onPage,
  children,
}: {
  page: number
  count: number
  step: number
  onPage: (p: number) => void
  children?: React.ReactNode
}) {
  const last = count - 1
  const label =
    step === 2 && page + 1 <= last ? `Pages ${page + 1} and ${page + 2} of ${count}` : `Page ${page + 1} of ${count}`
  return (
    <div className="bx-pagenav">
      <div className="bx-pagenav-row">
        <button
          type="button"
          className="bx-arrow"
          disabled={page <= 0}
          onClick={() => onPage(Math.max(0, page - step))}
          aria-label="Previous page"
        >
          <ChevronLeftIcon aria-hidden="true" />
        </button>
        <div className="bx-pagenav-label tnum" aria-live="polite">
          {label}
        </div>
        <button
          type="button"
          className="bx-arrow"
          disabled={page + step > last}
          onClick={() => onPage(Math.min(last, page + step))}
          aria-label="Next page"
        >
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </div>
      {count > 3 ? (
        <input
          type="range"
          className="bx-range"
          min={1}
          max={count}
          step={1}
          value={page + 1}
          aria-label="Jump to page"
          onChange={(e) => onPage(Number(e.target.value) - 1)}
        />
      ) : null}
      {children}
    </div>
  )
}
