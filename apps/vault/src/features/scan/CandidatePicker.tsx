import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Camera, CircleCheck, Handshake, Layers, ScanSearch, Search, Sparkles, TriangleAlert } from "lucide-react"

import { buttonClasses, Badge, Button, EmptyState, Money, Skeleton, useToast } from "@/ui"
import { cn } from "@/lib/cn"
import { useStaff } from "@/lib/auth"
import { errorMessage, requestGradedCheck, saveGradingConfig, useCardDetail } from "@/features/cards/api"
import { CardImage } from "@/features/cards/CardImage"
import { HeldBadge } from "@/features/cards/CardDetailPage"
import { conditionPrices, eraFor, type CardCondition } from "@/features/cards/condition-prices"
import { numberLabel } from "@/features/cards/format"
import { summariseGraded, type GradingConfig } from "@/features/cards/grading"
import { GradingPanel } from "@/features/cards/GradingPanel"
import { LanguageFlag } from "@/features/cards/LanguageFlag"

import { addToDeal } from "./addToDeal"
import { modelLabel, searchTextFor, type Candidate, type IdentifyResult } from "./api"
import { rememberScan } from "./history"

export interface CandidatePickerProps {
  photo: string
  result: IdentifyResult | undefined
  pending: boolean
  deepPending: boolean
  error: string | null
  dealId?: string
  onRetake: () => void
  onDeepDive: () => void
  /** Batch mode: adds the chosen card at the chosen condition to the tray, then the caller scans the next. */
  onAddToTray: (card: Candidate, condition: CardCondition, pence: number | null) => void
}

/**
 * After the shot: the photo beside the selected match, then the closest
 * 3 to 6 catalogue cards to pick from. Auto-accepted only when every signal
 * agreed (server side, lib/vault_scan.js `agreement`); otherwise the top
 * match is highlighted but staff choose. Once a card is chosen: its
 * condition prices, how many the shop already holds, and whether it is
 * worth grading.
 */
export function CandidatePicker({ photo, result, pending, deepPending, error, dealId, onRetake, onDeepDive, onAddToTray }: CandidatePickerProps) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [condition, setCondition] = React.useState<CardCondition>("NM")
  const candidates = result?.candidates ?? []
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null
  const busy = pending || deepPending
  const q = searchTextFor(result?.read)

  // The chosen card goes into this device's recent scans.
  const rememberedId = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!selected || busy || rememberedId.current === selected.id) return
    rememberedId.current = selected.id
    rememberScan(selected)
  }, [selected, busy])

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="label-mono mb-1 text-pop-text">{dealId ? "Scan into deal" : "Scan"}</p>
          <h1 className="font-display text-[clamp(2rem,1.4rem+2.4vw,3rem)] leading-[0.95] tracking-wide uppercase">
            {busy ? "Reading" : result?.auto_accept ? "Matched" : candidates.length ? "Pick the card" : "No match"}
          </h1>
        </div>
        <Button variant="secondary" size="sm" icon={<Camera className="size-4" aria-hidden />} onClick={onRetake}>
          Retake
        </Button>
      </header>

      {/* Status. */}
      <div aria-live="polite" className="flex min-h-6 flex-wrap items-center gap-2">
        {busy ? (
          <p className="text-sm text-fg-2">{deepPending ? "Deep dive on Sonnet 5.5..." : "Reading the card..."}</p>
        ) : error ? (
          <p className="text-sm font-medium text-pop-text">{error}</p>
        ) : result ? (
          result.auto_accept ? (
            <>
              <Badge tone="ok" dot>
                All signals agree
              </Badge>
              {selected && <HeldBadge held={selected.held} />}
            </>
          ) : (
            <p className="flex items-start gap-2 text-sm text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Check before you pick: {result.reasons.map((r, i) => (i === 0 ? r : r.charAt(0).toLowerCase() + r.slice(1))).join(", ")}.
              </span>
            </p>
          )
        ) : null}
        {result && !busy && !result.auto_accept && selected && <HeldBadge held={selected.held} />}
      </div>

      {/* Photo beside the selected match. */}
      <section aria-label="Compare" className="grid max-w-[340px] grid-cols-2 gap-3">
        <figure className="flex flex-col gap-2">
          <div className="relative aspect-[63/88] overflow-hidden rounded-[14px] bg-ink">
            <img src={photo} alt="Your photo" className="size-full object-cover" />
            {busy && <span className="absolute inset-0 animate-pulse border-2 border-volt/70 rounded-[14px]" aria-hidden />}
          </div>
          <figcaption className="label-mono text-[10px] text-fg-3">Your photo</figcaption>
        </figure>
        <figure className="flex flex-col gap-2">
          <div className="flex aspect-[63/88] items-center justify-center">
            {busy || !selected ? (
              <Skeleton className="size-full rounded-[14px]" />
            ) : (
              <CardImage src={selected.image_large || selected.image_small} alt={`${selected.name}, ${selected.set_name}`} width={200} className="!h-full !w-full" priority />
            )}
          </div>
          <figcaption className="label-mono text-[10px] text-fg-3">{selected && !busy ? "Selected match" : "Match"}</figcaption>
        </figure>
      </section>

      {/* The chosen card's prices, hold count and grading check. */}
      {selected && !busy && (
        <SelectedIntel
          key={selected.id}
          candidate={selected}
          dealId={dealId}
          condition={condition}
          onCondition={setCondition}
          onAddToDeal={() => addToDeal(navigate, dealId, selected.id, condition)}
          onAddToTray={(pence) => onAddToTray(selected, condition, pence)}
        />
      )}

      {result && !busy && (
        <p className="font-mono text-xs leading-relaxed text-fg-3">
          Read by {modelLabel(result.model)}
          {result.escalated ? ", checked again on Sonnet" : ""}:{" "}
          <span className="text-fg-2">
            {[result.read.name_en || result.read.name_printed, result.read.collector_number && (result.read.set_total ? `${result.read.collector_number}/${result.read.set_total}` : result.read.collector_number), result.read.set_code, (result.read.language || "").toUpperCase()]
              .filter(Boolean)
              .join(" · ") || "nothing legible"}
          </span>
        </p>
      )}

      {/* Candidates. */}
      {busy ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-[248px] rounded-lg" />
            </li>
          ))}
        </ul>
      ) : candidates.length > 0 ? (
        <section aria-labelledby="candidates-heading" className="flex flex-col gap-3">
          <h2 id="candidates-heading" className="label-mono text-fg-2">
            {candidates.length} closest {candidates.length === 1 ? "match" : "matches"}
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {candidates.map((c, index) => (
              <CandidateTile key={c.id} candidate={c} rank={index + 1} selected={selected?.id === c.id} onSelect={() => setSelectedId(c.id)} />
            ))}
          </ul>
        </section>
      ) : result || error ? (
        <EmptyState icon={<ScanSearch aria-hidden />} title="Not in the catalogue">
          Nothing in our catalogue matches this read. Try a deep dive, retake in better light, or search by name and number.
        </EmptyState>
      ) : null}

      {/* Other routes. */}
      {!busy && (result || error) && (
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button variant="ghost" className="border border-dashed border-line-2" icon={<Sparkles className="size-5" aria-hidden />} onClick={onDeepDive} disabled={result?.model.includes("sonnet") && !error}>
            Deep dive
          </Button>
          <Link to="/cards" search={{ q: q || undefined }} className={cn(buttonClasses("ghost", "md"), "border border-dashed border-line-2")}>
            <Search className="size-5" aria-hidden />
            Search instead
          </Link>
        </div>
      )}
    </div>
  )
}

/**
 * What staff need once a card is chosen: the actions, a condition chip row
 * with each condition's price (own UK sales, else estimated from NM), and
 * the "Worth grading?" panel. Reads the card route (database only) for the
 * comps, graded rows and fee config.
 */
function SelectedIntel({
  candidate,
  dealId,
  condition,
  onCondition,
  onAddToDeal,
  onAddToTray,
}: {
  candidate: Candidate
  dealId?: string
  condition: CardCondition
  onCondition: (c: CardCondition) => void
  onAddToDeal: () => void
  onAddToTray: (pence: number | null) => void
}) {
  const detail = useCardDetail(candidate.id)
  const toast = useToast()
  const staff = useStaff()
  const queryClient = useQueryClient()
  const data = detail.data
  const nm = data?.market.chosen?.gbp_market ?? candidate.nm_pence
  const rows = React.useMemo(() => conditionPrices(nm, data?.comps ?? [], eraFor(candidate.release_date)), [nm, data, candidate.release_date])
  const slabs = React.useMemo(() => summariseGraded(data?.graded_comps ?? []), [data])
  const chosen = rows.find((r) => r.condition === condition) ?? null
  const finish = data?.market.finish || candidate.finishes[0] || ""

  const graded$ = useMutation({
    mutationFn: ({ grader, grade }: { grader: string; grade: string }) => requestGradedCheck(candidate.id, finish, grader, grade),
    onSuccess: (res, { grader, grade }) => {
      toast({ message: res.existing ? `A ${grader} ${grade} check is already in the queue.` : `${grader} ${grade} check requested.`, tone: "ok" })
      void queryClient.invalidateQueries({ queryKey: ["vault-card", candidate.id] })
    },
    onError: (error) => toast({ message: errorMessage(error, "The graded check was not requested. Try again."), tone: "alert" }),
  })
  const saveFees = async (config: GradingConfig) => {
    await saveGradingConfig(config)
    toast({ message: "Grading fees saved.", tone: "ok" })
    void queryClient.invalidateQueries({ queryKey: ["vault-card", candidate.id] })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 sm:max-w-md">
        <Button className="flex-[1.4]" icon={<Handshake className="size-5" aria-hidden />} onClick={onAddToDeal}>
          {dealId ? "Add to this deal" : "Add to deal"}
        </Button>
        <Link to="/cards/$id" params={{ id: candidate.id }} search={{ deal: dealId }} className={cn(buttonClasses("secondary", "md"), "flex-1")}>
          Open card
        </Link>
      </div>

      {/* Condition chips, each with its price. */}
      <div role="radiogroup" aria-label="Condition" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0">
        {rows.map((row) => {
          const active = row.condition === condition
          return (
            <button
              key={row.condition}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onCondition(row.condition)}
              className={cn(
                "flex min-w-[84px] shrink-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-[border-color,background-color,transform] duration-200 ease-gg active:scale-[0.97]",
                active ? "border-volt bg-panel ring-2 ring-volt dark:[box-shadow:var(--glow-volt)]" : "border-line bg-panel-2 hover:border-line-2"
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="font-mono text-xs font-bold">{row.condition}</span>
                {row.estimated && <span className="label-mono text-[9px] text-warn">est</span>}
              </span>
              {detail.isPending && row.condition !== "NM" ? (
                <Skeleton className="h-4 w-12" />
              ) : row.pence != null ? (
                <Money pence={row.pence} size="sm" className="font-bold" />
              ) : (
                <span className="text-xs text-fg-3">No data</span>
              )}
            </button>
          )
        })}
      </div>

      <Button variant="secondary" block icon={<Layers className="size-5" aria-hidden />} onClick={() => onAddToTray(chosen?.pence ?? null)} className="sm:max-w-md">
        Add {condition} to tray and scan next
      </Button>

      {detail.isPending ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <GradingPanel
          compact
          raw={nm}
          slabs={slabs}
          config={data?.grading ?? { ace_standard_pence: 1500, psa_value_pence: 2500, postage_pence: 800, min_profit_pence: 1000, fees_checked_on: "" }}
          openRequests={data?.open_requests ?? []}
          onRequest={(grader, grade) => graded$.mutate({ grader, grade })}
          requesting={graded$.isPending}
          canEdit={staff?.role === "admin" || staff?.role === "manager"}
          onSaveConfig={saveFees}
        />
      )}
    </div>
  )
}

function CandidateTile({ candidate, rank, selected, onSelect }: { candidate: Candidate; rank: number; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "relative flex h-full w-full flex-col gap-2 rounded-lg border bg-panel p-2.5 text-left shadow-panel transition-[border-color,box-shadow,transform] duration-200 ease-gg active:scale-[0.98]",
          selected ? "border-volt ring-2 ring-volt dark:[box-shadow:var(--glow-volt)]" : "border-line hover:border-line-2"
        )}
      >
        <span className="label-mono absolute top-2 left-2 z-10 flex size-6 items-center justify-center rounded-full bg-ink text-[10px] text-paper dark:bg-paper dark:text-ink">{rank}</span>
        {selected && <CircleCheck className="absolute top-2 right-2 z-10 size-6 fill-volt text-ink" aria-hidden />}
        <span className="flex justify-center pt-1">
          <CardImage src={candidate.image_small || candidate.image_large} alt="" width={104} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold text-fg">{candidate.name}</span>
          <span className="truncate text-xs text-fg-2">{candidate.set_name || candidate.set_code}</span>
          <span className="flex items-center justify-between gap-1">
            <span className="font-mono text-xs text-fg-2 tnum">{numberLabel(candidate)}</span>
            <LanguageFlag language={candidate.language} />
          </span>
          {candidate.variant && <Badge className="max-w-full truncate">{candidate.variant}</Badge>}
          {candidate.held > 0 && <span className="label-mono text-[9px] text-info">Hold {candidate.held}</span>}
          <span className="mt-0.5 flex items-baseline justify-between">
            <span className="label-mono text-[10px] text-fg-3">NM</span>
            {candidate.nm_pence != null ? <Money pence={candidate.nm_pence} size="sm" className="font-bold" /> : <span className="text-xs text-fg-3">No price</span>}
          </span>
        </span>
      </button>
    </li>
  )
}
