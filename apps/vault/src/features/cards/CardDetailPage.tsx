import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, Handshake, PackagePlus, PencilLine, SearchCheck } from "lucide-react"

import { addToDeal } from "@/features/scan/addToDeal"
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  Money,
  MoneyInput,
  Segmented,
  Sheet,
  Skeleton,
  useToast,
} from "@/ui"

import { errorMessage, requestUkPriceCheck, setUkMarketPrice, useCardDetail, type CardDetail, type CardRow } from "./api"
import { CardImage } from "./CardImage"
import { averageOfLast, conditionPrices, CONDITIONS, eraFor, type CardCondition } from "./condition-prices"
import { languageName, multipleLabel, numberLabel, shortDate } from "./format"
import { LanguageFlag } from "./LanguageFlag"
import { cardmarketUrl, ebaySoldUrl, formatNative, sourceLabel } from "./links"
import { pickSeries } from "./chart-data"
import { PriceChart } from "./PriceChart"

export interface CardDetailPageProps {
  id: string
  /** The deal Scan or Cards was opened from, when there is one. */
  dealId?: string
}

export function CardDetailPage({ id, dealId }: CardDetailPageProps) {
  const query = useCardDetail(id)

  if (query.isPending) return <DetailSkeleton />
  if (query.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState title="Card not loaded">
          {errorMessage(query.error, "The card did not load. Check the connection and try again.")}
        </EmptyState>
      </div>
    )
  }
  return <CardDetailView detail={query.data} dealId={dealId} />
}

function BackLink() {
  return (
    <Link to="/cards" className="label-mono inline-flex w-fit items-center gap-1.5 text-fg-2 hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden />
      Cards
    </Link>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-label="Loading card">
      <BackLink />
      <div className="flex gap-4">
        <Skeleton className="h-[209px] w-[150px] rounded-md" />
        <div className="flex flex-1 flex-col gap-3 pt-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton lines={3} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    </div>
  )
}

function Tile({ label, children, foot }: { label: string; children: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="flex min-h-[104px] flex-col justify-between gap-2 rounded-lg border border-line bg-panel p-3.5 shadow-panel">
      <p className="label-mono text-[10px] text-fg-3">{label}</p>
      <div>{children}</div>
      {foot && <div className="text-xs text-fg-3">{foot}</div>}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="label-mono text-[10px] text-fg-3">{label}</dt>
      <dd className="truncate text-sm font-medium text-fg">{value}</dd>
    </div>
  )
}

function CardDetailView({ detail, dealId }: { detail: CardDetail; dealId?: string }) {
  const { card, market, comps, history, versions, research } = detail
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [compFilter, setCompFilter] = React.useState<CardCondition | "ALL">("ALL")
  const [priceSheet, setPriceSheet] = React.useState(false)

  const era = eraFor(card.release_date)
  const nm = market.chosen?.gbp_market ?? null
  const rows = conditionPrices(nm, comps, era)
  const anyEstimated = rows.some((r) => r.estimated)
  const grade10 =
    card.graded.find((g) => g.grader === "PSA" && /^10\b/.test(g.grade)) ?? card.graded.find((g) => /^10\b/.test(g.grade))
  const lastSold = comps[0] ?? null
  const avg5 = averageOfLast(comps)
  const finish = market.finish || card.finishes[0] || ""
  const series = pickSeries(history, market.chosen?.source)
  const shownComps = compFilter === "ALL" ? comps : comps.filter((c) => c.condition.toUpperCase() === compFilter)

  const research$ = useMutation({
    mutationFn: () => requestUkPriceCheck(card.id, finish, "NM"),
    onSuccess: (res) => {
      toast({ message: res.existing ? "A UK price check is already in the queue." : "UK price check requested.", tone: "ok" })
      void queryClient.invalidateQueries({ queryKey: ["vault-card", card.id] })
    },
    onError: (error) => toast({ message: errorMessage(error, "The price check was not requested. Try again."), tone: "alert" }),
  })

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      {/* Header: the card, what it is, and the actions. */}
      <section className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
        <div className="flex items-start gap-4 sm:block">
          <Card tilt className="shrink-0 border-0 bg-transparent p-0 shadow-none [backdrop-filter:none]">
            <CardImage src={card.image_large || card.image_small} alt={`${card.name}, ${card.set_name} ${numberLabel(card)}`} width={150} priority className="sm:!h-[307px] sm:!w-[220px]" />
          </Card>
          <div className="min-w-0 flex-1 sm:hidden">
            <HeaderText card={card} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="hidden sm:block">
            <HeaderText card={card} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Meta label="Set" value={card.set_name} />
            <Meta label="Number" value={<span className="font-mono tnum">{numberLabel(card)}</span>} />
            <Meta label="Rarity" value={card.rarity} />
            <Meta label="Finish" value={finish ? finish.replace(/(^|\s)\S/g, (s) => s.toUpperCase()) : ""} />
            <Meta label="Illustrator" value={card.illustrator} />
            <Meta label="Language" value={languageName(card.language)} />
          </dl>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button className="col-span-2 sm:col-span-1" icon={<Handshake className="size-5" aria-hidden />} onClick={() => addToDeal(navigate, dealId, card.id)}>
              {dealId ? "Add to this deal" : "Add to deal"}
            </Button>
            <Button variant="secondary" icon={<PackagePlus className="size-5" aria-hidden />} onClick={() => void navigate({ href: `/stock/new?card=${encodeURIComponent(card.id)}` })}>
              Add to stock
            </Button>
            <Button variant="secondary" icon={<PencilLine className="size-5" aria-hidden />} onClick={() => setPriceSheet(true)}>
              Set price
            </Button>
          </div>
        </div>
      </section>

      {/* Tiles. */}
      <section aria-label="Prices" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="NM market (UK)"
          foot={
            market.chosen ? (
              <>
                {sourceLabel(market.chosen.source)}
                {market.chosen.native_currency !== "GBP" && (
                  <> · from {formatNative(market.chosen.native_market, market.chosen.native_currency)}</>
                )}
                {market.chosen.stale && <> · stale</>}
              </>
            ) : (
              "No price source yet"
            )
          }
        >
          {nm != null ? <Money pence={nm} size="lg" /> : <span className="text-lg font-semibold text-fg-3">No price</span>}
        </Tile>
        <Tile
          label={grade10 ? `${grade10.grader} ${grade10.grade}` : "Grade 10"}
          foot={grade10 && nm ? `${multipleLabel(grade10.pence / nm)} NM` : grade10 ? "" : "No graded sales yet"}
        >
          {grade10 ? <Money pence={grade10.pence} size="lg" /> : <span className="text-lg font-semibold text-fg-3">None</span>}
        </Tile>
        <Tile label="Last sold, UK" foot={lastSold ? `${lastSold.condition} · ${shortDate(lastSold.sold_at)}` : "No UK sales recorded"}>
          {lastSold ? <Money pence={lastSold.pence} size="lg" /> : <span className="text-lg font-semibold text-fg-3">None</span>}
        </Tile>
        <Tile label="Average of last 5" foot={comps.length ? `${Math.min(5, comps.length)} UK ${comps.length === 1 ? "sale" : "sales"}` : "No UK sales recorded"}>
          {avg5 != null ? <Money pence={avg5} size="lg" /> : <span className="text-lg font-semibold text-fg-3">None</span>}
        </Tile>
      </section>

      {/* Condition row. */}
      <section aria-labelledby="conditions-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="conditions-heading" className="label-mono text-fg-2">
            By condition
          </h2>
          {anyEstimated && (
            <p className="text-xs text-fg-3">
              Estimated from NM, {era === "vintage" ? "vintage" : "modern"} curve
            </p>
          )}
        </div>
        <ul className="-mx-4 grid snap-x auto-cols-[minmax(116px,1fr)] grid-flow-col gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:grid-flow-row md:grid-cols-5 md:px-0">
          {rows.map((row) => (
            <li
              key={row.condition}
              className={
                "flex snap-start flex-col gap-1.5 rounded-lg border p-3 " +
                (row.condition === "NM" ? "border-fg/25 bg-panel shadow-panel" : "border-line bg-panel-2")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-bold">{row.condition}</span>
                {row.estimated && <Badge tone="warn">Estimated</Badge>}
              </div>
              {row.pence != null ? <Money pence={row.pence} className="text-lg font-bold" /> : <span className="text-lg font-semibold text-fg-3">No data</span>}
              <p className="text-xs text-fg-3">
                {row.sales} {row.sales === 1 ? "sale" : "sales"}
                {row.lastSold ? ` · ${shortDate(row.lastSold)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {series.points.length >= 2 && <PriceChart points={series.points} sourceLabel={sourceLabel(series.source)} />}

      {/* Sold list. */}
      <section aria-labelledby="sold-heading" className="flex flex-col gap-3">
        <h2 id="sold-heading" className="label-mono text-fg-2">
          UK sold
        </h2>
        <div role="group" aria-label="Filter by condition" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
          <Chip selected={compFilter === "ALL"} onClick={() => setCompFilter("ALL")}>
            All
          </Chip>
          {CONDITIONS.map((c) => (
            <Chip key={c} selected={compFilter === c} onClick={() => setCompFilter(c)}>
              {c}
            </Chip>
          ))}
        </div>
        {shownComps.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-2 px-4 py-6 text-center text-sm text-fg-3">
            {comps.length ? `No ${compFilter} sales recorded.` : "No UK sales recorded yet. Request a UK price check below."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {shownComps.map((comp) => (
              <li key={comp.id} className="flex items-center gap-3 py-3">
                <Badge className="w-12 justify-center">{comp.condition}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{comp.title || `${card.name} ${numberLabel(card)}`}</p>
                  <p className="text-xs text-fg-3">Sold {shortDate(comp.sold_at)}</p>
                </div>
                <Money pence={comp.pence} className="font-bold" />
                {comp.url && (
                  <a href={comp.url} target="_blank" rel="noreferrer" className="flex size-11 items-center justify-center rounded-full text-fg-2 hover:bg-line" aria-label="Open the listing on eBay">
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Research. */}
      <section aria-labelledby="research-heading" className="flex flex-col gap-3">
        <h2 id="research-heading" className="label-mono text-fg-2">
          Research
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <a href={ebaySoldUrl(card)} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line-2 px-4 text-[15px] font-semibold text-fg hover:border-fg-3">
            eBay UK sold
            <ExternalLink className="size-4 text-fg-3" aria-hidden />
          </a>
          <a href={cardmarketUrl(card)} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line-2 px-4 text-[15px] font-semibold text-fg hover:border-fg-3">
            Cardmarket
            <ExternalLink className="size-4 text-fg-3" aria-hidden />
          </a>
          <Button
            variant="ghost"
            className="col-span-2 border border-dashed border-line-2 sm:col-span-1"
            icon={<SearchCheck className="size-5" aria-hidden />}
            loading={research$.isPending}
            disabled={Boolean(research)}
            onClick={() => research$.mutate()}
          >
            {research ? (research.status === "claimed" ? "UK price check in progress" : "UK price check requested") : "Request UK price check"}
          </Button>
        </div>
      </section>

      {/* Other versions. */}
      {versions.length > 0 && (
        <section aria-labelledby="versions-heading" className="flex flex-col gap-3">
          <h2 id="versions-heading" className="label-mono text-fg-2">
            Other versions
          </h2>
          <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:mx-0 md:px-0">
            {versions.map((v) => (
              <VersionTile key={v.id} card={v} />
            ))}
          </ul>
        </section>
      )}

      <CustomPriceSheet open={priceSheet} onClose={() => setPriceSheet(false)} card={card} finish={finish} />
    </div>
  )
}

function HeaderText({ card }: { card: CardRow }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="label-mono flex items-center gap-2 text-pop-text">
        {card.game_name || card.game} · {card.set_code}
      </p>
      <h1 className="font-display text-[clamp(1.75rem,1.2rem+2.4vw,3rem)] leading-[0.95] tracking-wide uppercase [overflow-wrap:anywhere]">
        {card.name}
      </h1>
      <div className="flex flex-wrap items-center gap-2">
        <LanguageFlag language={card.language} />
        {card.variant && <Badge>{card.variant}</Badge>}
        <span className="font-mono text-sm text-fg-2 tnum">#{numberLabel(card)}</span>
      </div>
    </div>
  )
}

function VersionTile({ card }: { card: CardRow }) {
  return (
    <li className="w-[120px] shrink-0">
      <Link to="/cards/$id" params={{ id: card.id }} className="flex flex-col gap-2 rounded-md p-1 hover:bg-panel-2">
        <CardImage src={card.image_small} alt="" width={112} />
        <div className="min-w-0 px-0.5">
          <p className="truncate text-xs font-medium text-fg">{card.set_name}</p>
          <div className="mt-0.5 flex items-center justify-between gap-1">
            <span className="font-mono text-[11px] text-fg-3 tnum">{numberLabel(card)}</span>
            <LanguageFlag language={card.language} />
          </div>
          {card.variant && <p className="mt-0.5 truncate text-[11px] text-fg-2">{card.variant}</p>}
          <div className="mt-1">{card.nm_pence != null ? <Money pence={card.nm_pence} size="sm" className="font-bold" /> : <span className="text-xs text-fg-3">No price</span>}</div>
        </div>
      </Link>
    </li>
  )
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The custom market price: saved through the uk-comp route as a staff UK
 * sold comp, which leads every other source while it is fresh (30 days).
 */
function CustomPriceSheet({ open, onClose, card, finish }: { open: boolean; onClose: () => void; card: CardRow; finish: string }) {
  const [price, setPrice] = React.useState<number | null>(null)
  const [url, setUrl] = React.useState("")
  const [soldAt, setSoldAt] = React.useState(todayIso)
  const [condition, setCondition] = React.useState<CardCondition>("NM")
  const [error, setError] = React.useState<string | null>(null)
  const toast = useToast()
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: () => setUkMarketPrice(card.id, { finish, condition, price: price ?? 0, url: url.trim(), sold_at: soldAt }),
    onSuccess: () => {
      toast({ message: "UK market price saved.", tone: "ok" })
      void queryClient.invalidateQueries({ queryKey: ["vault-card", card.id] })
      onClose()
    },
    onError: (e) => setError(errorMessage(e, "The price was not saved. Try again.")),
  })

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Set market price"
      description="Saved as a UK sold price. It leads every other source for 30 days."
      footer={
        <Button block loading={save.isPending} disabled={!price || !url.trim()} onClick={() => save.mutate()}>
          Save price
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <MoneyInput label="Sold for" value={price} onChange={setPrice} size="lg" />
        <Segmented label="Condition" options={CONDITIONS.map((c) => ({ value: c, label: c }))} value={condition} onChange={setCondition} block />
        <Input label="eBay UK listing" hint="The sold listing's own link, ebay.co.uk/itm/..." inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.ebay.co.uk/itm/" />
        <Input label="Sold on" type="date" value={soldAt} max={todayIso()} onChange={(e) => setSoldAt(e.target.value)} error={error} />
      </div>
    </Sheet>
  )
}
