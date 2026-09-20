/**
 * Exports and imports: the files that go out to SumUp and eBay, and the ones
 * that come back.
 *
 * Two sections under one Anton line. Every export is a route in
 * docs/api-contract.md's Phase 4 section, fetched with the staff token and
 * handed to the browser; every import is the server's own, previewed here
 * first against the mapping in docs/csv-formats.md so nobody uploads the
 * wrong file into the wrong importer.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useCounterDock } from "@/app/counter-dock"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  countUnsyncedForSumUp,
  downloadExport,
  endListings as endListingsCall,
  inStockItemIds,
  lastRunOf,
  listEndListings,
} from "@/lib/api/exports"
import {
  ImportFileError,
  MAX_IMPORT_BYTES,
  importCardUploader,
  importEbayOrders,
  isZeroCostNote,
  problemRows,
  reviewRows,
} from "@/lib/api/imports"
import {
  CARD_UPLOADER_MAPPING,
  EBAY_ORDERS_MAPPING,
  UNRECOGNISED_FILE,
  mapRows,
  type MappedFile,
} from "@/lib/api/csv-parse"
import { useToday } from "@/lib/use-today"
import type {
  CsvImportRecord,
  CsvImportType,
  EndListingRow,
  ExportKey,
} from "@/lib/api/types"
import { formatDay, resolvePreset, rangeError } from "@/features/reports/range"
import {
  EXPORTS,
  exportFilename,
  exportPath,
  type ExportDef,
} from "@/features/exports/exports-list"
import { ImportPreview } from "@/features/exports/ImportPreview"
import { ReviewQueue } from "@/features/exports/ReviewQueue"

const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

function when(iso: string | null): string {
  if (!iso) return "Not taken on this computer yet"
  const date = new Date(iso)
  return `Last taken ${formatDay(iso.slice(0, 10))}, ${date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function ExportRow({
  def,
  detail,
  onRun,
  pending,
  disabled,
  children,
}: {
  def: ExportDef
  detail: string
  onRun: () => void
  pending: boolean
  /** A dated file cannot be taken while the range would be refused. */
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <li
      data-testid={`export-${def.key}`}
      className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-hairline-soft py-6 first:border-t"
    >
      <span className="flex min-w-[16rem] flex-1 flex-col gap-2">
        <span className="text-base text-foreground">{def.label}</span>
        <span className="max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          {def.note}
        </span>
        {/* Sentence case, not a micro-label: "Not taken on this computer
            yet" is a thirty-character uppercase run, which DESIGN.md's
            anti-patterns rule out and the detector flags. */}
        <span className="tnum text-[13px] leading-[1.45] text-muted-foreground">
          {detail}
        </span>
        {children}
      </span>
      {/* Seven black discs down one page is seven primary actions. The one
          block button on this screen is the import; taking a file is a
          secondary action, so it reads as the tracked text link it is. */}
      <Button
        variant="text"
        loading={pending}
        disabled={disabled}
        onClick={onRun}
        aria-label={`Download the ${def.label} file`}
      >
        Download
      </Button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// The file field
// ---------------------------------------------------------------------------

function FileField({
  id,
  label,
  filename,
  onFile,
}: {
  id: string
  label: string
  filename: string
  onFile: (file: File | null) => void
}) {
  return (
    <div className="mt-6">
      <MicroLabel className="mb-2">Choose file</MicroLabel>
      <div className="group/input relative flex min-h-10 items-center gap-3 pt-1 pb-3.5">
        <input
          id={id}
          type="file"
          accept=".csv,text/csv"
          aria-label={label}
          className="peer sr-only"
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
        <label
          htmlFor={id}
          className="flex min-h-12 flex-1 cursor-pointer items-center text-base leading-[1.5] text-foreground peer-focus-visible:underline peer-focus-visible:underline-offset-4"
        >
          {filename || (
            <span className="text-muted-foreground-2">No file chosen</span>
          )}
        </label>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-hairline"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[1.5px] origin-left scale-x-0 bg-volt transition-transform duration-150 ease-gg peer-focus-visible:scale-x-100"
        />
      </div>
    </div>
  )
}

interface Chosen {
  type: CsvImportType
  file: File
  mapped: MappedFile | null
  problem: string | null
}

// ---------------------------------------------------------------------------
// End listings
// ---------------------------------------------------------------------------

/** A hairline square, ticked in ink. The system has no checkbox of its own. */
function RowCheck({
  id,
  checked,
  onChange,
  label,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer size-5 cursor-pointer appearance-none rounded-[var(--radius)] border border-hairline bg-transparent outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
      />
      <CheckIcon
        aria-hidden="true"
        className="pointer-events-none absolute size-3.5 stroke-[2] text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  )
}

function EndListings({
  rows,
  loading,
  onEnded,
}: {
  rows: EndListingRow[]
  loading: boolean
  onEnded: () => void
}) {
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Every row to hand, ticked. Clearing the eBay fields cannot be undone, so
  // the ones being cleared are the ones that were actually ended, not
  // whatever happened to be on the list when the button was pressed.
  const [dropped, setDropped] = React.useState<string[]>([])

  const chosen = rows.filter((row) => !dropped.includes(row.item_id))
  const skus = chosen.map((row) => row.ebay_sku || row.sku).join("\n")

  const end = useMutation({
    mutationFn: () => endListingsCall(chosen.map((row) => row.item_id)),
    onSuccess: () => {
      setDropped([])
      onEnded()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "Those did not clear. Try again.")),
  })

  async function copy() {
    try {
      await navigator.clipboard.writeText(skus)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 3000)
    } catch {
      setError("The clipboard is not available here. Select the SKUs and copy them.")
    }
  }

  if (loading) return <SkeletonText lines={3} className="max-w-[40rem]" />

  if (rows.length === 0) {
    return (
      <p className="text-[15px] text-muted-foreground-2">
        Nothing sold in the shop is still listed on eBay.
      </p>
    )
  }

  return (
    <>
      <p className="mb-6 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "item" : "items"} sold in the shop
        {rows.length === 1 ? " is" : " are"} still listed on eBay. Copy the SKUs,
        end the listings in Seller Hub, then clear the ones you ended.
      </p>
      <ul data-testid="end-listings">
        {rows.map((row) => {
          const ticked = !dropped.includes(row.item_id)
          return (
            <li
              key={row.item_id}
              className="flex min-h-12 items-center gap-4 border-b border-hairline-soft py-3 first:border-t"
            >
              <RowCheck
                id={`end-${row.item_id}`}
                checked={ticked}
                label={`Ended ${row.title} on eBay`}
                onChange={(next) =>
                  setDropped((current) =>
                    next
                      ? current.filter((id) => id !== row.item_id)
                      : [...current, row.item_id]
                  )
                }
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[15px] text-foreground">{row.title}</span>
                <span className="tnum truncate font-mono text-[13px] text-muted-foreground-2">
                  {row.ebay_sku || row.sku}
                </span>
              </span>
              <span className="shrink-0 text-[13px] text-muted-foreground-2">
                {row.sold_at ? formatDay(row.sold_at.slice(0, 10)) : ""}
              </span>
            </li>
          )
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-6 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-8">
        <Button variant="text" onClick={copy} disabled={chosen.length === 0}>
          <CopyIcon aria-hidden="true" />
          {copied ? "Copied" : "Copy the SKUs"}
        </Button>
        <Button
          variant="text"
          onClick={() => end.mutate()}
          loading={end.isPending}
          disabled={chosen.length === 0}
        >
          {`Ended ${chosen.length} on eBay`}
        </Button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function ExportsScreen() {
  const dock = useCounterDock()
  const admin = useStaff()?.role === "admin"
  const today = React.useMemo(() => todayIso(), [])

  const [range, setRange] = React.useState(() => resolvePreset("month", today))
  const [sumupChanged, setSumupChanged] = React.useState(false)
  const [running, setRunning] = React.useState<ExportKey | null>(null)
  const [exportError, setExportError] = React.useState<string | null>(null)
  const [chosen, setChosen] = React.useState<Chosen | null>(null)
  const [result, setResult] = React.useState<CsvImportRecord | null>(null)
  const [summary, setSummary] = React.useState<string | null>(null)
  const [importError, setImportError] = React.useState<string | null>(null)

  const unsynced = useQuery({
    queryKey: ["sumup-unsynced"],
    queryFn: countUnsyncedForSumUp,
    staleTime: 60_000,
  })

  const listings = useQuery({
    queryKey: ["end-listings"],
    queryFn: listEndListings,
    staleTime: 30_000,
  })

  const rangeProblem = rangeError(range)

  const run = useMutation({
    mutationFn: async (def: ExportDef) => {
      setRunning(def.key)
      const ids = def.key === "ebay-listings" ? await inStockItemIds() : []
      const input = { from: range.from, to: range.to, sumupChanged, ids }
      await downloadExport({
        key: def.key,
        path: exportPath(def.key, input),
        filename: exportFilename(def.key, input),
      })
    },
    onMutate: () => setExportError(null),
    onSettled: () => setRunning(null),
    onSuccess: () => {
      void unsynced.refetch()
    },
    onError: (err) =>
      setExportError(
        refusalOrFallback(err, "That file did not download. Try again.")
      ),
  })

  async function chooseFile(type: CsvImportType, file: File | null) {
    setResult(null)
    setSummary(null)
    setImportError(null)
    if (!file) {
      setChosen(null)
      return
    }
    try {
      const mapping = type === "card_uploader" ? CARD_UPLOADER_MAPPING : EBAY_ORDERS_MAPPING
      const mapped = mapRows(await file.text(), mapping)
      const unreadable = mapped.fields.length === 0 || mapped.rows.length === 0
      setChosen({
        type,
        file,
        mapped: unreadable ? null : mapped,
        problem: unreadable ? UNRECOGNISED_FILE : null,
      })
    } catch {
      setChosen({
        type,
        file,
        mapped: null,
        problem: "That file could not be read. Export it again as a CSV.",
      })
    }
  }

  const runImport = useMutation({
    mutationFn: async () => {
      if (!chosen) throw new ImportFileError("Choose a file first.")
      if (chosen.type === "card_uploader") {
        const answer = await importCardUploader(chosen.file)
        return {
          record: answer.import,
          said: `${answer.matched} matched, ${answer.review} waiting to be matched.`,
        }
      }
      const answer = await importEbayOrders(chosen.file)
      return {
        record: answer.import,
        said: `${answer.sold} marked sold, ${answer.already_sold} already sold.`,
      }
    },
    onMutate: () => setImportError(null),
    onSuccess: ({ record, said }) => {
      setResult(record)
      setSummary(said)
      setChosen(null)
      void listings.refetch()
    },
    onError: (err) =>
      setImportError(
        err instanceof ImportFileError
          ? err.message
          : refusalOrFallback(err, "That file did not import. Try it again.")
      ),
  })

  const review = reviewRows(result)
  const problems = problemRows(result)

  const importReady = chosen !== null && chosen.problem === null
  const primary = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      disabled={!importReady || runImport.isPending}
      loading={runImport.isPending}
      onClick={() => runImport.mutate()}
    >
      Import the file
    </Button>
  )

  const visible = EXPORTS.filter((def) => !def.admin || admin)

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Exports and imports</PageTitle>
      <Lede>The files that go out to SumUp and eBay, and the ones that come back.</Lede>

      {/* ---- Exports ---- */}
      <section className="mt-14">
        <SectionHeading>Exports</SectionHeading>

        <div className="mb-10 flex flex-col gap-8 min-[560px]:flex-row min-[560px]:gap-10">
          <Field label="From" htmlFor="export-from" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="export-from"
              type="date"
              value={range.from}
              max={today}
              aria-invalid={Boolean(rangeProblem) || undefined}
              onChange={(event) => setRange({ ...range, from: event.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="export-to" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="export-to"
              type="date"
              value={range.to}
              max={today}
              aria-invalid={Boolean(rangeProblem) || undefined}
              onChange={(event) => setRange({ ...range, to: event.target.value })}
            />
          </Field>
        </div>
        <p className="mb-8 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          The dates are used by the sales, register, stock book and audit files.
          The rest ignore them.
        </p>
        {rangeProblem ? (
          <p role="alert" className="mb-8 text-[13px] text-destructive">
            {rangeProblem}
          </p>
        ) : null}

        <ul>
          {visible.map((def) => (
            <ExportRow
              key={def.key}
              def={def}
              detail={
                def.key === "sumup" && unsynced.data !== undefined
                  ? `${unsynced.data} waiting · ${when(lastRunOf(def.key))}`
                  : when(lastRunOf(def.key))
              }
              pending={running === def.key}
              onRun={() => run.mutate(def)}
            >
              {def.key === "sumup" ? (
                <span className="mt-2 flex items-center gap-3">
                  <Switch
                    id="sumup-changed"
                    checked={sumupChanged}
                    onCheckedChange={(checked: boolean) => setSumupChanged(checked)}
                    aria-label="Include lines that have changed since the from date"
                  />
                  <label htmlFor="sumup-changed" className="text-[13px] text-muted-foreground-2">
                    {sumupChanged
                      ? "Everything changed since the from date"
                      : "Only lines SumUp has never seen"}
                  </label>
                </span>
              ) : null}
            </ExportRow>
          ))}
        </ul>

        {exportError ? (
          <p role="alert" className="mt-6 text-[13px] text-destructive">
            {exportError}
          </p>
        ) : null}
      </section>

      {/* ---- Imports ---- */}
      <section className="mt-24">
        <SectionHeading>Imports</SectionHeading>
        <p className="mb-8 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
          Choose a file and the first ten rows are read back before anything is
          written.
        </p>

        <div className="border-b border-hairline-soft pb-8">
          <span className="text-base text-foreground">Card Uploader</span>
          <p className="mt-2 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            The per-card export. Rows with a TCGplayer or Cardmarket id list
            straight away; rows with only a name wait to be matched.
          </p>
          <FileField
            id="file-card-uploader"
            label="Card Uploader CSV"
            filename={chosen?.type === "card_uploader" ? chosen.file.name : ""}
            onFile={(file) => void chooseFile("card_uploader", file)}
          />
        </div>

        <div className="mt-8 border-b border-hairline-soft pb-8">
          <span className="text-base text-foreground">eBay orders</span>
          <p className="mt-2 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            The orders report. Each order becomes one sale against the items its
            custom labels name.
          </p>
          <FileField
            id="file-ebay-orders"
            label="eBay orders CSV"
            filename={chosen?.type === "ebay_orders" ? chosen.file.name : ""}
            onFile={(file) => void chooseFile("ebay_orders", file)}
          />
        </div>

        <p className="mt-8 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          SumUp sales are not a file. They come in on the hourly pull, and a
          day's card takings are compared on the Cash screen.
        </p>

        {chosen?.problem ? (
          <p role="alert" className="mt-8 text-[13px] text-destructive">
            {chosen.problem}
          </p>
        ) : null}

        {chosen?.mapped ? <ImportPreview file={chosen.mapped} type={chosen.type} /> : null}

        {importError ? (
          <p role="alert" className="mt-8 text-[13px] text-destructive">
            {importError}
          </p>
        ) : null}

        <div className="mt-10 hidden min-[900px]:block">{primary}</div>
      </section>

      {/* ---- What the import did ---- */}
      {result ? (
        <section className="mt-24" data-testid="import-result">
          <SectionHeading>What the import did</SectionHeading>
          <p className="text-[15px] text-foreground">
            {result.rows_total ?? 0} rows read, {result.rows_ok ?? 0} handled.
            {summary ? ` ${summary}` : ""}
          </p>
          {problems.length > 0 ? (
            <ul className="mt-6">
              {problems.map((entry, index) => (
                <li
                  key={`${entry.row ?? "x"}-${index}`}
                  className="flex min-h-12 items-baseline gap-4 border-b border-hairline-soft py-3 first:border-t"
                >
                  <span className="tnum shrink-0 font-mono text-[13px] text-foreground">
                    {entry.row ? `Line ${entry.row}` : "All"}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] text-muted-foreground-2">
                    {entry.kind === "already_sold"
                      ? `Already sold: ${entry.custom_label ?? ""}`
                      : entry.kind === "truncated"
                        ? `${entry.message ?? "More rows had problems"}`
                        : (entry.message ?? "")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-[15px] text-muted-foreground-2">
              Nothing was skipped.
            </p>
          )}
        </section>
      ) : null}

      {/* ---- The review queue ---- */}
      {result && result.type === "card_uploader" ? (
        <section className="mt-24">
          <SectionHeading>Waiting to be matched</SectionHeading>
          <ReviewQueue
            importId={result.id}
            rows={review}
            onChanged={(record) => setResult({ ...record })}
          />
        </section>
      ) : null}

      {/* ---- End these listings ---- */}
      <section className="mt-24">
        <SectionHeading>End these listings</SectionHeading>
        <EndListings
          rows={listings.data ?? []}
          onEnded={() => void listings.refetch()}
        />
      </section>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}
