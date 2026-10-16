/**
 * The supplier call (docs/api-contract-reorder.md, section 4.2): for
 * Richard's weekly call with a supplier's rep, what of theirs is in stock,
 * what sold, what is out, what to order to fill the shelf back up, and what
 * customers have asked for, on one screen.
 *
 * Every figure is the route's own (`GET /api/vault/reorder`, added up by the
 * shared `buildReorderLines` and `reorderTotals`); the screen only filters
 * the lines for a chip. The one Anton line is the supplier's name.
 */
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { defaultReorderPeriod, type ReorderLine, type ReorderReport, type ReorderTotals } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getReorderReport,
  listSuppliers,
  reorderKeys,
  setShelfTarget,
  suppliersKey,
} from "@/lib/api/reorder"
import { useToday } from "@/lib/use-today"
import { downloadXlsx } from "@/features/reports/excel"
import { formatRange, formatWhen, rangeError } from "@/features/reports/range"
import { reorderBook, reorderFilename } from "@/features/reorder/excel"
import { PrintReport } from "@/features/reorder/PrintReport"
import { Rack } from "@/features/reorder/Rack"
import { orderText, repLine, units, type RackView } from "@/features/reorder/rack"
import { RequestsSection } from "@/features/reorder/Requests"

export interface ReorderSearch {
  supplier?: string
  from?: string
  to?: string
  view?: RackView
}

interface Notice {
  tone: "info" | "error"
  text: string
}

/** The five figures across the top, in the dashboard's KPI style. */
const FIGURES: {
  key: keyof ReorderTotals
  label: string
  /** What the figure counts, said under it. */
  unit: (value: number) => string
}[] = [
  { key: "inStock", label: "In stock", unit: (n) => (n === 1 ? "unit" : "units") },
  { key: "sold", label: "Sold", unit: (n) => (n === 1 ? "unit" : "units") },
  { key: "outOfStock", label: "Out of stock", unit: (n) => (n === 1 ? "product" : "products") },
  { key: "toOrder", label: "To order", unit: (n) => (n === 1 ? "unit" : "units") },
  { key: "openRequests", label: "Requests", unit: () => "open" },
]

function Figures({ totals }: { totals: ReorderTotals }) {
  return (
    <dl
      data-testid="reorder-figures"
      className="mt-12 grid grid-cols-2 gap-x-10 gap-y-10 min-[640px]:grid-cols-3 min-[900px]:grid-cols-5"
    >
      {FIGURES.map((figure) => {
        const value = totals[figure.key]
        return (
          <div key={figure.key} className="flex flex-col gap-2">
            <dt>
              <MicroLabel>{figure.label}</MicroLabel>
            </dt>
            <dd className="m-0">
              <span
                data-testid={`reorder-${figure.key}`}
                className="tnum text-[20px] leading-none font-medium text-foreground"
              >
                {value.toLocaleString("en-GB")}
              </span>
              <span className="mt-2 block text-[13px] text-muted-foreground-2">{figure.unit(value)}</span>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** "Last 7 days" by default, or two date fields like every report's. */
function Period({
  range,
  today,
  custom,
  onCustom,
  onChange,
  error,
}: {
  range: { from: string; to: string }
  today: string
  custom: boolean
  onCustom: (custom: boolean) => void
  onChange: (next: { from?: string; to?: string }) => void
  error: string | null
}) {
  return (
    <div className="mt-10">
      <ChipGroup
        aria-label="Period"
        value={[custom ? "custom" : "last7"]}
        onValueChange={(next: string[]) => {
          const chosen = next[0]
          if (chosen === "last7") {
            onCustom(false)
            onChange({ from: undefined, to: undefined })
          } else if (chosen === "custom") {
            onCustom(true)
          }
        }}
      >
        <Chip value="last7">Last 7 days</Chip>
        <Chip value="custom">Custom</Chip>
      </ChipGroup>

      {custom ? (
        <div className="mt-8 flex flex-col gap-8 min-[560px]:flex-row min-[560px]:gap-10">
          <Field label="From" htmlFor="reorder-from" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="reorder-from"
              type="date"
              value={range.from}
              max={today}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => onChange({ from: event.target.value || undefined })}
            />
          </Field>
          <Field label="To" htmlFor="reorder-to" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="reorder-to"
              type="date"
              value={range.to}
              max={today}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => onChange({ to: event.target.value || undefined })}
            />
          </Field>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Hands the order to the clipboard, or says why it could not. */
async function copyToClipboard(text: string): Promise<boolean> {
  // `navigator.clipboard` is undefined outside a secure origin.
  const clipboard = navigator.clipboard as Clipboard | undefined
  if (!clipboard) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function ReorderScreen({
  search,
  onNavigate,
}: {
  search: ReorderSearch
  onNavigate: (next: Partial<ReorderSearch>) => void
}) {
  const today = useToday()
  const queryClient = useQueryClient()
  const fallback = defaultReorderPeriod(today)
  const range = { from: search.from ?? fallback.from, to: search.to ?? fallback.to }
  const isDefault = range.from === fallback.from && range.to === fallback.to
  const [customOpen, setCustomOpen] = React.useState(!isDefault)
  const custom = customOpen || !isDefault
  const invalid = rangeError(range)
  const view: RackView = search.view ?? "to_order"

  const [actionNote, setActionNote] = React.useState<Notice | null>(null)
  const [rackNote, setRackNote] = React.useState<Notice | null>(null)

  // Without a supplier in the address the call opens on the first one by
  // `sort`, which is Games Workshop.
  const suppliers = useQuery({
    queryKey: suppliersKey(true),
    queryFn: () => listSuppliers({ activeOnly: true }),
    staleTime: 5 * 60_000,
  })
  const firstSupplier = suppliers.data?.[0]?.id
  const redirected = React.useRef(false)
  React.useEffect(() => {
    if (search.supplier || !firstSupplier || redirected.current) return
    redirected.current = true
    onNavigate({ supplier: firstSupplier })
  }, [search.supplier, firstSupplier, onNavigate])

  const supplierId = search.supplier ?? ""
  const report = useQuery({
    queryKey: reorderKeys.report(supplierId, range.from, range.to),
    queryFn: () => getReorderReport({ supplierId, from: range.from, to: range.to }),
    enabled: Boolean(supplierId) && invalid === null,
    // A new period keeps the old figures up until the new ones land; a new
    // supplier never shows the last one's.
    placeholderData: (previous: ReorderReport | undefined) =>
      previous?.supplier.id === supplierId ? previous : undefined,
    // Read again on every visit: the till, Add stock and the item page all
    // change what is on the shelf between one look and the next.
    staleTime: 0,
  })
  const data = report.data ?? null

  const target = useMutation({
    mutationFn: ({ line, value }: { line: ReorderLine; value: number | null }) =>
      setShelfTarget(line.itemIds, value),
    onSuccess: (_, { line, value }) => {
      setRackNote({
        tone: "info",
        text:
          value === null
            ? `${line.title} has no Keep on shelf target now.`
            : `Keep on shelf for ${line.title} is ${value} now.`,
      })
      void queryClient.invalidateQueries({ queryKey: reorderKeys.all })
      void queryClient.invalidateQueries({ queryKey: ["items"] })
      void queryClient.invalidateQueries({ queryKey: ["item"] })
    },
    onError: (error) =>
      setRackNote({
        tone: "error",
        text: refusalOrFallback(error, "Keep on shelf did not save. Check the connection and try again."),
      }),
  })

  const name =
    data?.supplier.name ?? suppliers.data?.find((row) => row.id === supplierId)?.name ?? ""

  async function copyOrder() {
    if (!data) return
    const lines = data.lines.filter((line) => line.toOrder > 0)
    const copied = await copyToClipboard(orderText(data.lines))
    setActionNote(
      copied
        ? {
            tone: "info",
            text: `Order copied: ${lines.length} ${lines.length === 1 ? "product" : "products"}, ${units(data.totals.toOrder)}.`,
          }
        : {
            tone: "error",
            text: "This browser would not let the order be copied. Use Export Excel and copy it from the To order sheet.",
          }
    )
  }

  function exportExcel() {
    if (!data) return
    downloadXlsx(reorderFilename(data), reorderBook(data))
    setActionNote({ tone: "info", text: "Excel file made: To order, Rack and Requests." })
  }

  // ---- No supplier at all --------------------------------------------------
  if (!supplierId && suppliers.isSuccess && suppliers.data.length === 0) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Supplier calls</PageTitle>
        <Lede>No supplier is set up yet. A manager adds one in Settings, under Suppliers.</Lede>
        <div className="mt-12">
          <Button variant="text" render={<Link to="/counter/reports" />}>
            All reports
          </Button>
        </div>
      </section>
    )
  }

  const rep = data ? repLine(data.supplier) : ""

  return (
    <>
      <section className="pt-16 sm:pt-24 print:hidden" data-testid="reorder-screen">
        {name || report.error ? (
          <PageTitle>{name || "Supplier call"}</PageTitle>
        ) : (
          <Skeleton className="h-9 w-64" />
        )}
        <Lede>The weekly call: what sold, what is out, what to order and what customers asked for.</Lede>
        {rep ? (
          <p
            data-testid="reorder-rep"
            className="tnum mt-2 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2"
          >
            {rep}
          </p>
        ) : null}

        <Period
          range={range}
          today={today}
          custom={custom}
          onCustom={setCustomOpen}
          onChange={onNavigate}
          error={invalid}
        />
        <p data-testid="range-line" className="mt-6 text-[15px] text-muted-foreground">
          {formatRange(range)}
        </p>
        {report.error ? (
          // The route's own sentence: an unknown supplier, or dates it refused.
          <p role="alert" data-testid="reorder-error" className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
            {refusalOrFallback(report.error, "The supplier call would not load. Check the connection and try again.")}
          </p>
        ) : null}

        {!data ? (
          invalid || report.error ? null : (
            <SkeletonText lines={4} className="mt-12 max-w-[40rem]" />
          )
        ) : (
          <>
            <Figures totals={data.totals} />

            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3">
              <Button variant="text" disabled={data.totals.toOrder === 0} onClick={() => void copyOrder()}>
                Copy order
              </Button>
              <Button variant="text" onClick={exportExcel}>
                Export Excel
              </Button>
              <Button variant="text" onClick={() => window.print()}>
                Print
              </Button>
            </div>
            {actionNote ? (
              <p
                data-testid="reorder-action-note"
                aria-live="polite"
                className={
                  actionNote.tone === "error"
                    ? "mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-destructive"
                    : "mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground"
                }
              >
                {actionNote.text}
              </p>
            ) : null}

            <section className="mt-16" aria-labelledby="rack-heading">
              <SectionHeading id="rack-heading">The rack</SectionHeading>
              <Rack
                lines={data.lines}
                view={view}
                onViewChange={(next) => {
                  setRackNote(null)
                  onNavigate({ view: next === "to_order" ? undefined : next })
                }}
                supplierName={data.supplier.name}
                when={formatWhen(range)}
                saving={target.isPending}
                onTarget={(line, value) => target.mutate({ line, value })}
                onProblem={(text) => setRackNote({ tone: "error", text })}
              />
              {rackNote ? (
                <p
                  data-testid="rack-note"
                  aria-live="polite"
                  className={
                    rackNote.tone === "error"
                      ? "mt-4 text-[13px] leading-[1.45] text-destructive"
                      : "mt-4 text-[13px] leading-[1.45] text-muted-foreground"
                  }
                >
                  {rackNote.text}
                </p>
              ) : null}
            </section>

            <RequestsSection
              supplier={{ id: data.supplier.id, name: data.supplier.name }}
              requests={data.requests}
            />
          </>
        )}

        <div className="mt-24">
          <Button variant="text" render={<Link to="/counter/reports" />}>
            All reports
          </Button>
        </div>
      </section>

      {data ? <PrintReport report={data} rep={rep} /> : null}
    </>
  )
}
