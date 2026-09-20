/**
 * Cash: open the drawer with a counted float, watch what should be in it, and
 * close it against a count.
 *
 * `cash_movements.amount` is signed, so the expected total is the float plus
 * every movement and the table can print each one as it stands. A variance
 * inside `settings.cash_variance_alert` carries a volt badge; over it, the
 * figure turns destructive and the server audits the close
 * (docs/api-contract.md, "Cash sessions").
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import { StickerOrbit } from "@/components/ui/sticker"
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
import { Textarea } from "@/components/ui/textarea"
import { useCounterDock } from "@/app/counter-dock"
import { MoneyInput } from "@/features/sell/money-input"
import { useCounterConfig } from "@/lib/api/config"
import { refusalOrFallback } from "@/lib/api/refusal"
import { todayIso } from "@/lib/api/dates"
import { SumUpSection } from "@/features/cash/SumUpSection"
import {
  addCashMovement,
  closeCashSession,
  getCurrentCashSession,
  listCashSessions,
  openCashSession,
} from "@/lib/api"
import type { CashCloseResult, CashMovementType } from "@/lib/api/types"

/** See the same constant on the Sell screen: a blocked block stays legible. */
const BLOCKED =
  "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

const MOVEMENT_LABELS: Record<CashMovementType, string> = {
  float_in: "Float in",
  payout: "Buy-in payout",
  cash_sale: "Cash sale",
  refund: "Refund",
  bank_drop: "Bank drop",
  adjustment: "Adjustment",
}

function time(iso?: string): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function day(iso?: string): string {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })
}

/**
 * The variance, in words and in figures.
 *
 * Inside tolerance it carries a volt badge, which is ink on yellow and one of
 * the five places volt is allowed; over the alert the figure turns
 * `--destructive` and a sentence says what to do. Volt itself is 1.3:1 on the
 * paper canvas, so it marks the good case rather than printing it.
 */
function Variance({
  variance,
  over,
  testId,
}: {
  variance: number
  over: boolean
  testId: string
}) {
  const word =
    variance === 0
      ? "Spot on"
      : `${variance > 0 ? "Over" : "Short"} ${formatGBP(Math.abs(variance))}`

  return (
    <p data-testid={testId} className="mt-8 flex flex-wrap items-center gap-4">
      <span
        className={
          over
            ? "tnum font-display text-[28px] leading-none text-destructive"
            : "tnum font-display text-[28px] leading-none text-foreground"
        }
      >
        {word}
      </span>
      {over ? (
        <Badge variant="outline">Over the alert</Badge>
      ) : (
        <Badge variant="volt">In tolerance</Badge>
      )}
    </p>
  )
}

/**
 * The form inside the movement sheet. It is a child of `SheetContent`, which
 * Base UI mounts only while the sheet is open, so the fields are empty every
 * time it opens without an effect reaching in to clear them.
 */
function MovementForm({
  type,
  pending,
  onSave,
  onCancel,
}: {
  type: "bank_drop" | "adjustment"
  pending: boolean
  onSave: (amount: number, ref: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState("")
  const [ref, setRef] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const drop = type === "bank_drop"

  function save() {
    const pence = parseDecimalToMinor(value)
    if (pence === null || pence === 0) {
      setError("Enter the amount in pounds and pence, for example 200.00.")
      return
    }
    if (drop && pence < 0) {
      setError("A bank drop is the amount leaving the drawer, so enter it as a positive figure.")
      return
    }
    onSave(drop ? -Math.abs(pence) : pence, ref)
  }

  return (
    <>
      <SheetBody>
        <Field layout="stacked" label="Amount" htmlFor="movement-amount">
          <MoneyInput
            id="movement-amount"
            autoFocus
            value={value}
            onChange={(next) => {
              setValue(next)
              setError(null)
            }}
            invalid={Boolean(error)}
          />
        </Field>
        <FieldError>{error}</FieldError>
        <Field
          layout="stacked"
          label="Reference"
          htmlFor="movement-ref"
          className="mt-8"
        >
          <Input
            id="movement-ref"
            value={ref}
            maxLength={100}
            placeholder={drop ? "Bag number" : "Why the drawer changed"}
            onChange={(event) => setRef(event.target.value)}
          />
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button onClick={save} loading={pending} trailingArrow>
          {drop ? "Record drop" : "Record adjustment"}
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

function MovementSheet({
  open,
  onOpenChange,
  type,
  pending,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: "bank_drop" | "adjustment"
  pending: boolean
  onSave: (amount: number, ref: string) => void
}) {
  const drop = type === "bank_drop"
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{drop ? "Bank drop" : "Adjustment"}</SheetTitle>
          <SheetDescription>
            {drop
              ? "Cash taken out of the drawer and banked."
              : "A correction, up or down. Say why in the reference."}
          </SheetDescription>
        </SheetHeader>
        <MovementForm
          type={type}
          pending={pending}
          onSave={onSave}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

export function CashScreen() {
  const dock = useCounterDock()
  const [floatValue, setFloatValue] = React.useState("")
  const [counted, setCounted] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [sheet, setSheet] = React.useState<"bank_drop" | "adjustment" | null>(null)
  const [closed, setClosed] = React.useState<CashCloseResult | null>(null)
  // Today by default, and a past session's own day once one is picked out of
  // the history below, so a drawer that was closed yesterday can still be
  // compared against SumUp.
  const today = React.useMemo(() => todayIso(), [])
  const [sumupDate, setSumupDate] = React.useState(today)

  const current = useQuery({
    queryKey: ["cash-current"],
    queryFn: getCurrentCashSession,
    staleTime: 5_000,
  })
  const history = useQuery({
    queryKey: ["cash-sessions"],
    queryFn: () => listCashSessions(10),
    staleTime: 30_000,
  })
  const config = useCounterConfig()

  const session = current.data?.session ?? null
  const expected = current.data?.expected ?? 0
  const movements = current.data?.movements ?? []
  // `settings` is admin-only, so the threshold comes from the config route,
  // shared with the Sell screen. Zero, including before it has loaded, means
  // no alert: the close route reads it the same way.
  const alertAt = config.data?.cashVarianceAlert ?? 0

  function refresh() {
    void current.refetch()
    void history.refetch()
  }

  const open = useMutation({
    mutationFn: (pence: number) => openCashSession(pence),
    onSuccess: () => {
      setFloatValue("")
      setError(null)
      setClosed(null)
      refresh()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "The drawer did not open. Try again.")),
  })

  const movement = useMutation({
    mutationFn: ({
      type,
      amount,
      ref,
    }: {
      type: CashMovementType
      amount: number
      ref: string
    }) => addCashMovement(session?.id ?? "", type, amount, ref),
    onSuccess: () => {
      setSheet(null)
      refresh()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "That did not record. Try again.")),
  })

  const close = useMutation({
    mutationFn: (pence: number) => closeCashSession(session?.id ?? "", pence, notes),
    onSuccess: (result) => {
      setClosed(result)
      setCounted("")
      setNotes("")
      setError(null)
      refresh()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "The drawer did not close. Count it again.")),
  })

  const countedPence = parseDecimalToMinor(counted)
  const floatPence = parseDecimalToMinor(floatValue)
  // Only once something has been typed: an empty field is not a mistake yet.
  const countedInvalid = counted.trim() !== "" && countedPence === null
  const floatInvalid = floatValue.trim() !== "" && floatPence === null
  const liveVariance = countedPence === null ? null : countedPence - expected
  const overAlert =
    liveVariance !== null && alertAt > 0 && Math.abs(liveVariance) > alertAt

  const primary = session ? (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={close.isPending}
      disabled={countedPence === null || close.isPending}
      onClick={() => countedPence !== null && close.mutate(countedPence)}
    >
      Close session
    </Button>
  ) : (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={open.isPending}
      disabled={floatPence === null || open.isPending}
      onClick={() => {
        if (floatPence !== null) open.mutate(floatPence)
      }}
    >
      Open session
    </Button>
  )

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Cash</PageTitle>
      <Lede>Open with a float, watch the drawer, close against a count.</Lede>

      {closed ? (
        <div className="mt-14" aria-live="polite" data-testid="cash-closed">
          <Seal tick />
          <p className="mt-8 text-base text-muted-foreground">
            Session closed. Expected {formatGBP(closed.expected)}, counted{" "}
            {formatGBP(closed.session.counted ?? 0)}.
          </p>
          <Variance
            testId="closed-variance"
            variance={closed.variance}
            over={closed.overAlert}
          />
          {closed.overAlert ? (
            <p className="mt-3 text-[13px] text-destructive">
              That is over the alert of {formatGBP(alertAt)} and has been recorded.
            </p>
          ) : null}
        </div>
      ) : null}

      {session ? (
        <>
          <div className="mt-16">
            <MicroLabel tone="ink" className="mb-5">
              Open drawer
            </MicroLabel>
            <div className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-4 border-b border-hairline-soft pb-6">
              <span className="flex flex-col gap-1">
                <span className="text-[15px] text-foreground">
                  Opened {time(session.opened_at)}, float{" "}
                  <span className="tnum">{formatGBP(session.float ?? 0)}</span>
                </span>
                <span className="text-[13px] text-muted-foreground-2">
                  {movements.length === 0
                    ? "Nothing in or out yet"
                    : `${movements.length} movement${movements.length === 1 ? "" : "s"} so far`}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <MicroLabel>Expected</MicroLabel>
                <span
                  data-testid="cash-expected"
                  className="tnum font-display text-[28px] leading-none text-foreground"
                >
                  {formatGBP(expected)}
                </span>
              </span>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-8">
              <Button variant="text" onClick={() => setSheet("bank_drop")}>
                Bank drop
              </Button>
              <Button variant="text" onClick={() => setSheet("adjustment")}>
                Adjustment
              </Button>
            </div>
          </div>

          <div className="mt-16">
            <MicroLabel tone="ink" className="mb-5">
              Movements
            </MicroLabel>
            {movements.length === 0 ? (
              <p className="text-[15px] text-muted-foreground-2">
                Nothing has moved in or out yet.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead numeric>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-[13px]">
                        {time(row.created)}
                      </TableCell>
                      <TableCell>{MOVEMENT_LABELS[row.type]}</TableCell>
                      <TableCell className="text-muted-foreground-2">
                        {row.ref || row.staffName || ""}
                      </TableCell>
                      <TableCell numeric>{formatGBP(row.amount ?? 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <SumUpSection
            date={sumupDate}
            onDateChange={setSumupDate}
            maxDate={today}
          />

          <div className="mt-16">
            <MicroLabel tone="ink" className="mb-5">
              Close
            </MicroLabel>
            <Field label="Counted" htmlFor="cash-counted">
              <MoneyInput
                id="cash-counted"
                value={counted}
                onChange={setCounted}
                invalid={countedInvalid}
                aria-label="Counted"
              />
              {countedInvalid ? (
                <FieldError>
                  Enter the count in pounds and pence, for example 124.50.
                </FieldError>
              ) : null}
            </Field>
            <Field label="Notes" htmlFor="cash-notes" className="mt-10">
              <Textarea
                id="cash-notes"
                maxLength={500}
                placeholder="Anything that explains the count"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>

            {liveVariance !== null ? (
              <Variance
                testId="cash-variance"
                variance={liveVariance}
                over={overAlert}
              />
            ) : null}
            {overAlert ? (
              <p className="mt-3 text-[13px] text-destructive">
                Over the {formatGBP(alertAt)} alert. Count it again before closing.
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="mt-6 text-[13px] text-destructive">
                {error}
              </p>
            ) : null}

            <div className="mt-12 hidden min-[900px]:block">{primary}</div>
          </div>
        </>
      ) : (
        <div className="mt-16">
          <MicroLabel tone="ink" className="mb-5">
            Open a session
          </MicroLabel>
          <div className="flex flex-col items-start gap-6">
            <StickerOrbit />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              No cash session is open, so no cash sale and no cash payout can go
              through. Count the float and open one.
            </p>
          </div>
          <Field label="Float" htmlFor="cash-float" className="mt-12">
            <MoneyInput
              id="cash-float"
              value={floatValue}
              onChange={setFloatValue}
              invalid={floatInvalid}
              aria-label="Float"
            />
            {floatInvalid ? (
              <FieldError>
                Enter the float in pounds and pence, for example 100.00.
              </FieldError>
            ) : null}
          </Field>
          {error ? (
            <p role="alert" className="mt-6 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-12 hidden min-[900px]:block">{primary}</div>
        </div>
      )}

      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Past sessions
        </MicroLabel>
        {(history.data ?? []).filter((row) => row.closed_at).length === 0 ? (
          <p className="text-[15px] text-muted-foreground-2">
            No session has been closed yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead numeric>Float</TableHead>
                <TableHead numeric>Expected</TableHead>
                <TableHead numeric>Counted</TableHead>
                <TableHead numeric>Variance</TableHead>
                {/* A seventh column pushes this table off a phone, so the
                    shortcut is a desktop one; the day field in the SumUp
                    section reaches any closed day at either width. */}
                <TableHead className="hidden min-[900px]:table-cell">SumUp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(history.data ?? [])
                .filter((row) => row.closed_at)
                .map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{day(row.opened_at)}</TableCell>
                    <TableCell className="font-mono text-[13px]">
                      {time(row.opened_at)}
                    </TableCell>
                    <TableCell numeric>{formatGBP(row.float ?? 0)}</TableCell>
                    <TableCell numeric>{formatGBP(row.expected ?? 0)}</TableCell>
                    <TableCell numeric>{formatGBP(row.counted ?? 0)}</TableCell>
                    <TableCell numeric>{formatGBP(row.variance ?? 0)}</TableCell>
                    <TableCell className="hidden min-[900px]:table-cell">
                      <Button
                        variant="text"
                        onClick={() =>
                          setSumupDate((row.closed_at ?? row.opened_at ?? today).slice(0, 10))
                        }
                      >
                        Compare
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}

      <MovementSheet
        open={sheet !== null}
        onOpenChange={(next) => {
          if (!next) setSheet(null)
        }}
        type={sheet ?? "bank_drop"}
        pending={movement.isPending}
        onSave={(amount, ref) =>
          movement.mutate({ type: sheet ?? "bank_drop", amount, ref })
        }
      />
    </section>
  )
}
