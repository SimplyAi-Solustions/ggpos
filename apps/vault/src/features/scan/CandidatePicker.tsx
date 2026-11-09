import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Camera, CircleCheck, Handshake, ScanSearch, Search, Sparkles, TriangleAlert } from "lucide-react"

import { buttonClasses, Badge, Button, EmptyState, Money, Skeleton } from "@/ui"
import { cn } from "@/lib/cn"
import { CardImage } from "@/features/cards/CardImage"
import { numberLabel } from "@/features/cards/format"
import { LanguageFlag } from "@/features/cards/LanguageFlag"

import { addToDeal } from "./addToDeal"
import { modelLabel, searchTextFor, type Candidate, type IdentifyResult } from "./api"

export interface CandidatePickerProps {
  photo: string
  result: IdentifyResult | undefined
  pending: boolean
  deepPending: boolean
  error: string | null
  dealId?: string
  onRetake: () => void
  onDeepDive: () => void
}

/**
 * After the shot: the photo beside the selected match, then the closest
 * 3 to 6 catalogue cards to pick from. Auto-accepted only when every signal
 * agreed (server side, lib/vault_scan.js `agreement`); otherwise the top
 * match is highlighted but staff choose.
 */
export function CandidatePicker({ photo, result, pending, deepPending, error, dealId, onRetake, onDeepDive }: CandidatePickerProps) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const candidates = result?.candidates ?? []
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null
  const busy = pending || deepPending
  const q = searchTextFor(result?.read)

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
            <Badge tone="ok" dot>
              All signals agree
            </Badge>
          ) : (
            <p className="flex items-start gap-2 text-sm text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Check before you pick: {result.reasons.map((r, i) => (i === 0 ? r : r.charAt(0).toLowerCase() + r.slice(1))).join(", ")}.
              </span>
            </p>
          )
        ) : null}
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

      {/* Choose. */}
      {selected && !busy && (
        <div className="flex gap-2 sm:max-w-md">
          <Button className="flex-[1.4]" icon={<Handshake className="size-5" aria-hidden />} onClick={() => addToDeal(navigate, dealId, selected.id)}>
            {dealId ? "Add to this deal" : "Add to deal"}
          </Button>
          <Link to="/cards/$id" params={{ id: selected.id }} search={{ deal: dealId }} className={cn(buttonClasses("secondary", "md"), "flex-1")}>
            Open card
          </Link>
        </div>
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
          <span className="mt-0.5 flex items-baseline justify-between">
            <span className="label-mono text-[10px] text-fg-3">NM</span>
            {candidate.nm_pence != null ? <Money pence={candidate.nm_pence} size="sm" className="font-bold" /> : <span className="text-xs text-fg-3">No price</span>}
          </span>
        </span>
      </button>
    </li>
  )
}
