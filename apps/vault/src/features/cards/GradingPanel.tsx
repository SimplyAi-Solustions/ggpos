import * as React from "react"
import { Award, PencilLine, SearchCheck } from "lucide-react"
import { formatGBP } from "@gg/shared/money"

import { Badge, Button, Input, Money, MoneyInput, Sheet, type BadgeTone } from "@/ui"
import { cn } from "@/lib/cn"

import type { OpenRequest } from "./api"
import { multipleLabel, shortDate } from "./format"
import { gradingOutcome, slabKey, VERDICT_LABELS, type GradingConfig, type SlabOutcome, type SlabPrice, type Verdict } from "./grading"

export interface GradingPanelProps {
  /** The raw NM market, pence, or null. */
  raw: number | null
  slabs: readonly SlabPrice[]
  config: GradingConfig
  openRequests: readonly OpenRequest[]
  onRequest: (grader: string, grade: string) => void
  requesting?: boolean
  /** Managers and admins can edit the fees. */
  canEdit: boolean
  onSaveConfig: (config: GradingConfig) => Promise<unknown>
  /** A tighter layout for the scan result. */
  compact?: boolean
  className?: string
}

const VERDICT_TONE: Record<Verdict, BadgeTone> = { worth: "ok", marginal: "warn", not_worth: "pop", unknown: "neutral" }

/**
 * "Worth grading?": PSA 10, PSA 9 and ACE 10 against the raw NM price, the
 * multiple, the shop's grading cost, the profit at a 10 and at a 9, and one
 * verdict. With no graded data for a slab it says so and offers a graded
 * check. Fees come from settings.grading and are edited here.
 */
export function GradingPanel({ raw, slabs, config, openRequests, onRequest, requesting, canEdit, onSaveConfig, compact, className }: GradingPanelProps) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<GradingConfig>(config)
  const openFees = () => {
    setDraft(config)
    setEditing(true)
  }
  const outcome = gradingOutcome(raw, slabs, config)
  const best = outcome.best
  const nine = best ? outcome.rows.find((r) => r.slab.grader === best.slab.grader && r.slab.grade === "9") : null
  const anyData = slabs.length > 0

  return (
    <section aria-labelledby="grading-heading" className={cn("flex flex-col gap-3 rounded-lg border border-line bg-panel p-3.5 shadow-panel sm:p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-full bg-volt text-on-volt shadow-volt">
            <Award className="size-4" aria-hidden />
          </span>
          <div className="flex flex-col">
            <h2 id="grading-heading" className="label-mono text-fg-2">
              Worth grading?
            </h2>
            {!compact && <p className="text-xs text-fg-3">Slab prices against raw NM, less the fees.</p>}
          </div>
        </div>
        <Badge tone={VERDICT_TONE[outcome.verdict]} dot className="h-7 shrink-0 text-[11px]">
          {VERDICT_LABELS[outcome.verdict]}
        </Badge>
      </div>

      <p className="text-sm text-fg-2">{outcome.reason}</p>

      <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
        <Tile label="Raw NM" foot={raw != null ? "UK-first market" : "No price source yet"} strong>
          {raw != null ? <Money pence={raw} className="text-lg font-bold" /> : <span className="text-lg font-semibold text-fg-3">No price</span>}
        </Tile>
        {outcome.rows.map((row) => (
          <SlabTile key={slabKey(row.slab)} row={row} request={openRequests.find((r) => r.grader === row.slab.grader && r.grade === row.slab.grade)} onRequest={onRequest} requesting={requesting} />
        ))}
      </div>

      {best && best.profit != null && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-panel-2 px-3.5 py-3 text-sm">
          <div className="flex flex-col">
            <dt className="label-mono text-[10px] text-fg-3">If it gets a {best.slab.grader} 10</dt>
            <dd>
              <Profit pence={best.profit} />
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="label-mono text-[10px] text-fg-3">If it gets a {best.slab.grader} 9</dt>
            <dd>{nine?.profit != null ? <Profit pence={nine.profit} /> : <span className="text-fg-3">No {best.slab.grader} 9 data</span>}</dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-fg-3">
        <p>
          Grading cost {formatGBP(config.ace_standard_pence + config.postage_pence)} ACE, {formatGBP(config.psa_value_pence + config.postage_pence)} PSA, with post.{" "}
          <span className="text-warn">{config.fees_checked_on ? `Fees checked ${shortDate(config.fees_checked_on)}.` : "Check current fees."}</span>
        </p>
        <button type="button" onClick={openFees} className="inline-flex h-8 items-center gap-1 rounded-sm px-2 font-medium text-fg-2 hover:bg-line hover:text-fg">
          <PencilLine className="size-3.5" aria-hidden />
          {canEdit ? "Edit fees" : "Fees"}
        </button>
      </div>

      {!anyData && (
        <p className="text-xs text-fg-3">No graded sales recorded for this card. A graded check asks for UK sold slabs; UK eBay listings fill in once the shop's eBay key is set.</p>
      )}

      <FeesSheet open={editing} onClose={() => setEditing(false)} draft={draft} setDraft={setDraft} canEdit={canEdit} onSave={onSaveConfig} />
    </section>
  )
}

function Tile({ label, foot, strong, children }: { label: string; foot?: React.ReactNode; strong?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-h-[92px] flex-col justify-between gap-1 rounded-md border p-3", strong ? "border-fg/25 bg-panel" : "border-line bg-panel-2")}>
      <p className="label-mono text-[10px] text-fg-3">{label}</p>
      <div>{children}</div>
      {foot && <p className="truncate text-[11px] text-fg-3">{foot}</p>}
    </div>
  )
}

function SlabTile({ row, request, onRequest, requesting }: { row: SlabOutcome; request: OpenRequest | undefined; onRequest: (grader: string, grade: string) => void; requesting?: boolean }) {
  const label = slabKey(row.slab)
  if (!row.price) {
    return (
      <div className="flex min-h-[92px] flex-col justify-between gap-1 rounded-md border border-dashed border-line-2 p-3">
        <p className="label-mono text-[10px] text-fg-3">{label}</p>
        <p className="text-sm font-semibold text-fg-3">No data</p>
        <button
          type="button"
          disabled={Boolean(request) || requesting}
          onClick={() => onRequest(row.slab.grader, row.slab.grade)}
          className="inline-flex min-h-6 items-center gap-1 text-left text-[11px] font-semibold text-fg-2 hover:text-fg disabled:text-fg-3"
        >
          <SearchCheck className="size-3.5 shrink-0" aria-hidden />
          {request ? (request.status === "claimed" ? "Check in progress" : "Check requested") : "Request check"}
        </button>
      </div>
    )
  }
  const source = row.price.fromSales ? `UK sold · ${row.price.count} ${row.price.count === 1 ? "row" : "rows"}` : row.price.source === "ebay_uk_asking" ? "From UK listings" : "UK sold"
  return (
    <Tile label={label} foot={`${source} · ${shortDate(row.price.at)}`}>
      <div className="flex flex-col">
        <Money pence={row.price.pence} className="text-lg font-bold" />
        {row.multiple != null && <span className="font-mono text-[11px] text-fg-2 tnum">{multipleLabel(row.multiple)} raw</span>}
      </div>
    </Tile>
  )
}

function Profit({ pence }: { pence: number }) {
  const tone = pence > 0 ? "text-ok" : pence < 0 ? "text-pop-text" : "text-fg"
  return (
    <span className={cn("font-mono text-base font-bold tnum", tone)}>
      {pence > 0 ? "+" : pence < 0 ? "-" : ""}
      {formatGBP(Math.abs(pence))}
    </span>
  )
}

function FeesSheet({
  open,
  onClose,
  draft,
  setDraft,
  canEdit,
  onSave,
}: {
  open: boolean
  onClose: () => void
  draft: GradingConfig
  setDraft: React.Dispatch<React.SetStateAction<GradingConfig>>
  canEdit: boolean
  onSave: (config: GradingConfig) => Promise<unknown>
}) {
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const set = (key: keyof GradingConfig) => (value: number | null) => setDraft((d) => ({ ...d, [key]: value ?? 0 }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      onClose()
    } catch (e) {
      const message = (e as { response?: { message?: string } })?.response?.message
      setError(message || "The fees were not saved. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Grading fees"
      description={canEdit ? "Per card, in pounds. Check the graders' current price lists before you rely on these." : "Per card. A manager or admin can change these."}
      footer={
        canEdit ? (
          <Button block loading={saving} onClick={() => void save()}>
            Save fees
          </Button>
        ) : (
          <Button block variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <fieldset disabled={!canEdit} className="flex flex-col gap-4">
        <MoneyInput label="ACE Grading, standard" value={draft.ace_standard_pence} onChange={set("ace_standard_pence")} />
        <MoneyInput label="PSA, value tier" value={draft.psa_value_pence} onChange={set("psa_value_pence")} />
        <MoneyInput label="Post, there and back" value={draft.postage_pence} onChange={set("postage_pence")} />
        <MoneyInput label="Minimum profit for Worth grading" value={draft.min_profit_pence} onChange={set("min_profit_pence")} hint="Under this at a 10, the verdict is Marginal." />
        <Input label="Fees checked on" type="date" value={draft.fees_checked_on} onChange={(e) => setDraft((d) => ({ ...d, fees_checked_on: e.target.value }))} error={error} />
      </fieldset>
    </Sheet>
  )
}
