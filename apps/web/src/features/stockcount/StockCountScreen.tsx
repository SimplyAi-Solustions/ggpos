/**
 * One open count: scan the shelf, watch what is still missing, close it
 * against the difference.
 *
 * Scan-first, like the Sell screen. The field takes focus on load and takes
 * it back when nothing else wants it, so a wedge scanner works without a
 * click, and a code typed by hand commits on Enter. Every scan is written to
 * its line as it happens, so two people can count one location from two
 * phones and a dropped tab loses nothing but the scan in the air.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode, normaliseCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import { Switch } from "@/components/ui/switch"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useCounterDock } from "@/app/counter-dock"
import { registerScanField } from "@/app/focus-registry"
import { setScanHandler } from "@/app/scan-bus"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  closeStockCount,
  getStockCount,
  lookupCountItem,
  saveCountLine,
} from "@/lib/api"
import {
  applyScan,
  stillMissing,
  summarise,
  unexpectedLines,
} from "@/features/stockcount/reconcile"
import type { StockCountDetail, StockCountLine } from "@/lib/api/types"

const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

/** Panels own the pointer while they are open; the field must not fight them. */
const KEEPS_FOCUS =
  "input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu'], [data-slot='sheet-content'], [data-slot='dialog-content'], [data-slot='select-content'], [data-slot='menu-content']"

function time(iso: string): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

/** One figure of the summary, in the secondary figure size. */
function Figure({
  label,
  value,
  testId,
}: {
  label: string
  value: number
  testId: string
}) {
  return (
    <span className="flex flex-col gap-1">
      <MicroLabel>{label}</MicroLabel>
      <span data-testid={testId} className="tnum text-[20px] leading-none font-medium">
        {value}
      </span>
    </span>
  )
}

function LineTable({
  lines,
  caption,
  testId,
  showRecordedAt,
}: {
  lines: StockCountLine[]
  caption: string
  testId: string
  showRecordedAt?: boolean
}) {
  if (lines.length === 0) {
    return <p className="text-[15px] text-muted-foreground-2">{caption}</p>
  }
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Code</TableHead>
          {showRecordedAt ? <TableHead>Recorded at</TableHead> : null}
          <TableHead numeric>Expected</TableHead>
          <TableHead numeric>Found</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.id} data-testid={`${testId}-row`}>
            <TableCell>
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] text-foreground">{line.title || "Item"}</span>
                {line.detail ? (
                  <span className="text-[13px] text-muted-foreground-2">{line.detail}</span>
                ) : null}
              </span>
            </TableCell>
            <TableCell className="font-mono text-[13px]">
              <Link
                to="/counter/stock/$sku"
                params={{ sku: line.sku }}
                className="underline-offset-4 hover:underline"
              >
                {displayCode(line.sku)}
              </Link>
            </TableCell>
            {showRecordedAt ? <TableCell>{line.locationName}</TableCell> : null}
            <TableCell numeric>{line.expectedQty}</TableCell>
            <TableCell numeric>{line.scannedQty}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function CloseSheet({
  open,
  onOpenChange,
  count,
  lines,
  pending,
  onClose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: StockCountDetail
  lines: StockCountLine[]
  pending: boolean
  onClose: (moveUnexpected: boolean) => void
}) {
  const [move, setMove] = React.useState(false)
  const totals = summarise(lines)
  const extras = unexpectedLines(lines)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Close the count</SheetTitle>
          <SheetDescription>
            {count.locationName}: {totals.expected} expected, {totals.scanned} found,{" "}
            {totals.missing} missing, {totals.unexpected} not expected here.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {extras.length > 0 ? (
            <div className="flex items-start justify-between gap-6">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] text-foreground">
                  Move the {extras.length} unexpected{" "}
                  {extras.length === 1 ? "item" : "items"} here
                </span>
                <span className="text-[13px] text-muted-foreground-2">
                  Their location becomes {count.locationName}, which is where they
                  actually are.
                </span>
              </span>
              <Switch
                checked={move}
                onCheckedChange={setMove}
                aria-label={`Move the unexpected items to ${count.locationName}`}
              />
            </div>
          ) : (
            <p className="text-[15px] text-muted-foreground-2">
              Nothing turned up that belongs somewhere else.
            </p>
          )}
          {totals.missing > 0 ? (
            <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
              {totals.missing} {totals.missing === 1 ? "unit is" : "units are"} still
              missing. Closing records the difference; it does not write the stock
              off. Write each one off on its own item page when you are sure.
            </p>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button loading={pending} trailingArrow onClick={() => onClose(move)}>
            Close count
          </Button>
          <Button variant="text" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function StockCountScreen({ id }: { id: string }) {
  const dock = useCounterDock()
  const staff = useStaff()
  const queryClient = useQueryClient()
  // The field is only mounted once the count has loaded, so the effect that
  // gives it focus and registers it with the wedge listener has to run when
  // it appears rather than when the screen does: the callback ref holds it in
  // state for that, and in a ref for everything that only reads it.
  const scanRef = React.useRef<HTMLInputElement | null>(null)
  const [scanField, setScanField] = React.useState<HTMLInputElement | null>(null)
  const attachScan = React.useCallback((node: HTMLInputElement | null) => {
    scanRef.current = node
    setScanField(node)
  }, [])

  const [lines, setLines] = React.useState<StockCountLine[] | null>(null)
  const [scanError, setScanError] = React.useState<string | null>(null)
  const [scanNote, setScanNote] = React.useState<string | null>(null)
  const [closeOpen, setCloseOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const count = useQuery({
    queryKey: ["stock-count", id],
    queryFn: () => getStockCount(id),
    staleTime: 10_000,
  })

  // The server's lines until the first scan, then ours: a scan has to tick a
  // row off the moment it lands, not when the next fetch comes back.
  const data = count.data ?? null
  const current = lines ?? data?.lines ?? []
  const totals = summarise(current)
  const missing = stillMissing(current)
  const extras = unexpectedLines(current)
  const closed = data?.status === "closed"
  const admin = staff?.role === "admin"

  const write = useMutation({
    mutationFn: (line: StockCountLine) => saveCountLine(id, line),
    // A line written for the first time comes back with its real id, which
    // replaces the draft one so the next scan updates it rather than
    // creating a second row for the same item.
    onSuccess: (saved) =>
      setLines((rows) =>
        (rows ?? []).map((row) => (row.itemId === saved.itemId ? { ...row, id: saved.id } : row))
      ),
    onError: (err) =>
      setError(refusalOrFallback(err, "That scan did not save. Scan it again.")),
  })

  const commit = React.useCallback(
    async (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      if (scanRef.current) scanRef.current.value = ""
      setScanError(null)
      setScanNote(null)
      setError(null)

      const rows = lines ?? count.data?.lines ?? []
      if (count.data?.status === "closed") {
        setScanError("This count is closed. Start a new one to count again.")
        return
      }

      try {
        // Only a code with no line on the count needs a lookup: everything
        // expected here is already in front of us.
        const code = normaliseCode(trimmed)
        const known = rows.some((row) => row.sku && normaliseCode(row.sku) === code)
        const item = known ? null : await lookupCountItem(trimmed)
        const result = applyScan(rows, trimmed, item)
        if (result.outcome.kind === "unknown") {
          setScanError(
            `${displayCode(result.outcome.sku)} is not a code we hold. Check the label.`
          )
          return
        }
        setLines(result.lines)
        write.mutate(result.outcome.line)

        const line = result.outcome.line
        if (result.outcome.kind === "extra") {
          setScanNote(
            `${displayCode(line.sku)} is not expected here. It is recorded at ${line.locationName}.`
          )
          return
        }
        if (result.outcome.kind === "over") {
          setScanNote(
            `${line.title || "That item"} was already found. That is ${line.scannedQty - line.expectedQty} more than expected.`
          )
          return
        }
        setScanNote(`${line.title || "Item"} found.`)
      } catch (err) {
        setScanError(refusalOrFallback(err, "That code could not be looked up. Try again."))
      }
    },
    [count.data, lines, write]
  )

  React.useEffect(() => setScanHandler((raw) => void commit(raw)), [commit])

  React.useEffect(() => {
    const field = scanField
    if (!field || closed) return undefined
    field.focus()
    const unregister = registerScanField(field)

    function reclaim(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(KEEPS_FOCUS)) return
      if (document.querySelector("[data-slot='sheet-content'],[data-slot='dialog-content']"))
        return
      field?.focus()
    }

    document.addEventListener("pointerup", reclaim)
    return () => {
      document.removeEventListener("pointerup", reclaim)
      unregister()
    }
  }, [closed, scanField])

  const finish = useMutation({
    mutationFn: (moveUnexpected: boolean) => closeStockCount(id, moveUnexpected),
    onSuccess: (result) => {
      setCloseOpen(false)
      setLines(result.lines)
      setError(null)
      queryClient.setQueryData(["stock-count", id], result)
      void queryClient.invalidateQueries({ queryKey: ["stock-counts"] })
      void queryClient.invalidateQueries({ queryKey: ["items"] })
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "That count did not close. Try again.")),
  })

  const primary = closed ? null : (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      disabled={!admin}
      onClick={() => setCloseOpen(true)}
    >
      Close count
    </Button>
  )

  if (count.isLoading) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Stock count</PageTitle>
        <p className="mt-14 text-[15px] text-muted-foreground-2">Loading the count.</p>
      </section>
    )
  }

  if (!data) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Stock count</PageTitle>
        <Lede>
          That count is not here. It may have been deleted. Start a new one from
          the stock count screen.
        </Lede>
        <div className="mt-12">
          <Button variant="text" render={<Link to="/counter/stock/count" />}>
            Back to stock counts
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Stock count</PageTitle>
      <Lede>
        {data.locationName}, started {time(data.startedAt)} by {data.startedByName}.
      </Lede>

      {closed ? (
        <div className="mt-14" aria-live="polite" data-testid="count-closed">
          <Seal tick />
          <p className="mt-8 text-base text-muted-foreground">
            Count closed. {totals.expected} expected, {totals.scanned} found.
          </p>
        </div>
      ) : (
        <div className="mt-14">
          <Input
            ref={attachScan}
            size="scan"
            data-testid="count-scan-field"
            leadingIcon={<BarcodeGlyph />}
            trailingHint="Press enter"
            placeholder="Scan what is on the shelf"
            aria-label="Scan an item on the shelf"
            aria-invalid={scanError ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            onChange={() => setScanError(null)}
          />
          <FieldError>{scanError}</FieldError>
          {scanNote && !scanError ? (
            <p
              data-testid="count-scan-note"
              aria-live="polite"
              className="mt-2 text-[13px] text-muted-foreground"
            >
              {scanNote}
            </p>
          ) : null}
        </div>
      )}

      <div
        data-testid="count-summary"
        className="mt-14 flex flex-wrap items-start gap-x-12 gap-y-6 border-y border-hairline-soft py-5"
      >
        <Figure label="Expected" value={totals.expected} testId="count-expected" />
        <Figure label="Found" value={totals.scanned} testId="count-scanned" />
        <Figure label="Missing" value={totals.missing} testId="count-missing" />
        <Figure label="Not expected" value={totals.unexpected} testId="count-unexpected" />
        {closed ? <Badge variant="outline">Closed</Badge> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-6 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-8">
        <SectionHeading>Still missing</SectionHeading>
        <LineTable
          lines={missing}
          testId="missing-lines"
          caption={
            totals.expected === 0
              ? "This location was recorded as empty when the count started."
              : "Everything the shelf should hold has been found."
          }
        />
      </div>

      <div className="mt-8">
        <SectionHeading>Not expected here</SectionHeading>
        <LineTable
          lines={extras}
          testId="extra-lines"
          showRecordedAt
          caption="Nothing has turned up that belongs somewhere else."
        />
      </div>

      {!closed && !admin ? (
        <p className="mt-12 text-[13px] text-muted-foreground">
          An admin closes a count, because the variance goes on the record. Leave
          it open and ask one to finish it.
        </p>
      ) : null}

      <div className="mt-16 hidden min-[900px]:block">{primary}</div>

      {dock && primary
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}

      <CloseSheet
        open={closeOpen}
        onOpenChange={setCloseOpen}
        count={data}
        lines={current}
        pending={finish.isPending}
        onClose={(move) => finish.mutate(move)}
      />
    </section>
  )
}
