import * as React from "react"
import { Link } from "@tanstack/react-router"
import { CheckCircle2, FileUp, RotateCcw, Upload } from "lucide-react"

import { cn } from "@/lib/cn"
import { Badge, Button, buttonClasses, Card, EmptyState, PageHeader, Panel, useToast } from "@/ui"

import { errorText, importCardUploader, useStockMutation, type ImportResult } from "./api"
import { SelectField } from "./components/SelectField"
import { StockNav } from "./components/StockNav"
import { autoMap, canImport, canonicalCsv, IMPORT_FIELDS, previewImport, readTable, type ColumnMap, type ParsedImport } from "./import/mapping"

const MAX_BYTES = 10 * 1024 * 1024

export function ImportPage() {
  const toast = useToast()
  const input = React.useRef<HTMLInputElement>(null)
  const [file, setFile] = React.useState<File | null>(null)
  const [parsed, setParsed] = React.useState<ParsedImport | null>(null)
  const [map, setMap] = React.useState<ColumnMap>({})
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ImportResult | null>(null)

  const preview = React.useMemo(() => (parsed ? previewImport(parsed, map) : null), [parsed, map])
  const blocked = canImport(map)

  const load = async (picked: File | undefined) => {
    setError(null)
    setResult(null)
    if (!picked) return
    if (picked.size > MAX_BYTES) return setError("That file is over 10 MB. Split it and import each part.")
    const text = await picked.text()
    const table = readTable(text)
    if (table.header.length === 0 || table.body.length === 0) return setError("That file has no rows. Check it is the CSV export, not the spreadsheet.")
    setFile(picked)
    setParsed(table)
    setMap(autoMap(table.header))
  }

  const reset = () => {
    setFile(null)
    setParsed(null)
    setMap({})
    setResult(null)
    if (input.current) input.current.value = ""
  }

  const run = useStockMutation(async () => {
    if (!parsed || !file) throw new Error("No file")
    const csv = canonicalCsv(parsed, map)
    return importCardUploader(new File([csv], file.name.replace(/\.csv$/i, "") + "-mapped.csv", { type: "text/csv" }))
  })

  return (
    <section className="pb-6">
      <PageHeader eyebrow="Inventory" title="Import">
        Bring stock in from a CSV. Map the columns, check the preview, then import.
      </PageHeader>
      <StockNav />

      {result ? (
        <Card accent="volt" className="flex flex-col items-start gap-3">
          <CheckCircle2 className="size-10 text-ok" aria-hidden />
          <h2 className="font-display text-3xl uppercase tracking-wide">Imported</h2>
          <p className="text-fg-2">
            {result.matched} matched to the catalogue and added or linked. {result.review} waiting for a manual match.
            {result.import.errors.length > 0 && ` ${result.import.errors.length} rows need a look.`}
          </p>
          <p className="text-sm text-fg-3">
            New items from an import carry no cost. Health lists them under thin margins until a cost is added.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/stock" className={buttonClasses("primary")}>
              See stock
            </Link>
            <Button variant="secondary" icon={<RotateCcw className="size-4" aria-hidden />} onClick={reset}>
              Import another
            </Button>
          </div>
        </Card>
      ) : !parsed ? (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex w-full flex-col items-center gap-3 rounded-lg border-2 border-dashed border-line-2 bg-panel-2 px-6 py-12 text-center transition-colors hover:border-volt"
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-volt text-on-volt shadow-volt">
              <Upload className="size-6" aria-hidden />
            </span>
            <span className="font-display text-2xl uppercase tracking-wide">Choose a CSV</span>
            <span className="max-w-[40ch] text-fg-2">
              A Card Uploader export reads straight in. Any other CSV works once its columns are mapped.
            </span>
          </button>
          {error && (
            <p role="alert" className="mt-3 text-sm font-medium text-pop-text">
              {error}
            </p>
          )}
          <p className="mt-4 text-sm text-fg-3">
            Rows with a TCGplayer or Cardmarket id match the card exactly. Rows with only a name wait for a manual match. Format: docs/csv-formats.md.
          </p>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.2fr]">
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="label-mono text-fg-3">File</p>
                <p className="truncate font-semibold">{file?.name}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={reset}>
                Change
              </Button>
            </div>
            <p className="label-mono mt-2 text-pop-text">Map columns</p>
            {IMPORT_FIELDS.map((field) => (
              <SelectField
                key={field.key}
                label={field.label}
                hint={field.hint || undefined}
                value={String(map[field.key] ?? -1)}
                onChange={(v) => setMap((m) => ({ ...m, [field.key]: Number(v) }))}
                options={[
                  { value: "-1", label: "Not in this file" },
                  ...parsed.header.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
                ]}
              />
            ))}
          </Card>

          <div className="flex flex-col gap-4">
            <Card accent="volt">
              <p className="label-mono mb-3 text-fg-2">Preview</p>
              <div className="grid grid-cols-3 gap-2">
                <Count label="Match" value={preview?.matched ?? 0} tone="text-ok" />
                <Count label="Review" value={preview?.review ?? 0} tone="text-warn" />
                <Count label="Problems" value={preview?.errors ?? 0} tone="text-pop-text" />
              </div>
              <Button
                size="lg"
                block
                className="mt-4"
                icon={<FileUp className="size-5" aria-hidden />}
                disabled={Boolean(blocked) || !preview?.rows.length}
                loading={run.isPending}
                onClick={() =>
                  run.mutate(undefined, {
                    onSuccess: (res) => setResult(res),
                    onError: (err) => toast({ message: errorText(err, "The import did not go through. Check the file and try again."), tone: "alert", duration: 8000 }),
                  })
                }
              >
                Import {preview?.rows.length ?? 0} rows
              </Button>
              {blocked && <p className="mt-2 text-sm font-medium text-pop-text">{blocked}</p>}
            </Card>

            <Panel flush className="overflow-hidden">
              {preview && preview.rows.length > 0 ? (
                <ul className="divide-y divide-line">
                  {preview.rows.slice(0, 8).map((r, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{r.row.name || r.row.tcgplayerId || r.row.cardmarketId || "No name"}</span>
                        <span className="block truncate text-xs text-fg-3">
                          {[r.row.set, r.row.number && `#${r.row.number}`, r.row.condition, r.row.quantity && `x${r.row.quantity}`].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {r.row.price && <span className="shrink-0 font-mono tnum">£{r.row.price.replace(/^£/, "")}</span>}
                      <Badge tone={r.verdict.kind === "matched" ? "ok" : r.verdict.kind === "review" ? "warn" : "pop"}>
                        {r.verdict.kind === "matched" ? "Match" : r.verdict.kind === "review" ? "Review" : "Problem"}
                      </Badge>
                    </li>
                  ))}
                  {preview.rows.length > 8 && <li className="px-4 py-2.5 text-sm text-fg-3">and {preview.rows.length - 8} more rows</li>}
                </ul>
              ) : (
                <EmptyState className="m-4" title="No rows">
                  Map a column to see the preview.
                </EmptyState>
              )}
            </Panel>
          </div>
        </div>
      )}

      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void load(e.target.files?.[0])} />
    </section>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 p-3">
      <p className="label-mono text-[10px] text-fg-3">{label}</p>
      <p className={cn("font-mono text-2xl font-bold tnum", value > 0 && tone)}>{value}</p>
    </div>
  )
}
