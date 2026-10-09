/**
 * Returns (docs/EPOS-PLAN.md, "Returns and exchanges"): find a sale by its
 * receipt number or by scanning the receipt's barcode, choose the lines and
 * quantities coming back, say why, put them back in stock or not, and give
 * the money back to the original card, in cash or as store credit, in any
 * split that adds up. A role without `refund` gets a manager's approval on
 * the spot (`withOverride`); the server checks the drawer can cover cash.
 *
 * A card refund is done on the Tide reader by hand, like a card payment:
 * the till records it.
 */
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { displayCode, formatGBP, parseDecimalToMinor, type SaleLookup } from "@gg/shared"
import { MinusIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { MoneyInput } from "@/features/sell/money-input"
import { OverrideCancelled } from "@/features/lock/override"
import { openDrawer, printReceipt } from "@/features/printing/receipt"
import { storedTenderLabel } from "@/features/till/tenders"
import {
  REFUND_METHODS,
  defaultRefundMethod,
  initialChoice,
  originalCardLast4,
  refundTenders,
  refundTotal,
  type RefundMethod,
} from "@/features/till/returns"
import { refusalOrFallback } from "@/lib/api/refusal"
import { lookupSale, refundTillSale, type TillRefundResult } from "@/lib/api/till"

const TALL = "min-h-14"

function when(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  return at.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Stepper({
  value,
  max,
  label,
  onChange,
}: {
  value: number
  max: number
  label: string
  onChange: (next: number) => void
}) {
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={`One fewer ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        className="flex size-12 items-center justify-center rounded-[var(--radius)] text-foreground outline-none transition-colors duration-150 ease-gg hover:bg-secondary focus-visible:bg-secondary disabled:text-muted-foreground-2 disabled:hover:bg-transparent"
      >
        <MinusIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
      </button>
      <span className="tnum w-8 text-center text-[16px] text-foreground">{value}</span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className="flex size-12 items-center justify-center rounded-[var(--radius)] text-foreground outline-none transition-colors duration-150 ease-gg hover:bg-secondary focus-visible:bg-secondary disabled:text-muted-foreground-2 disabled:hover:bg-transparent"
      >
        <PlusIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
      </button>
    </span>
  )
}

function RefundForm({
  sale,
  onDone,
}: {
  sale: SaleLookup
  onDone: (result: TillRefundResult, cash: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [chosen, setChosen] = React.useState(() => initialChoice(sale))
  const [reason, setReason] = React.useState("")
  const [restock, setRestock] = React.useState(true)
  const [methods, setMethods] = React.useState<RefundMethod[]>(() => [defaultRefundMethod(sale)])
  const [amounts, setAmounts] = React.useState<Partial<Record<RefundMethod, string>>>({})
  const [last4, setLast4] = React.useState(() => originalCardLast4(sale))
  const [error, setError] = React.useState<string | null>(null)

  const total = refundTotal(sale, chosen)
  const split = methods.length > 1

  const refund = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("Say why it is coming back.")
      const tenders = refundTenders(
        methods,
        Object.fromEntries(
          methods.map((method) => [method, parseDecimalToMinor(amounts[method] ?? "")])
        ),
        total,
        last4,
        Boolean(sale.customer)
      )
      if (!tenders.ok) throw new Error(tenders.message)
      const lines = sale.lines
        .filter((line) => (chosen[line.id] ?? 0) > 0)
        .map((line) => ({ sale_line: line.id, qty: chosen[line.id] ?? 0, restock }))
      const result = await refundTillSale(
        sale.id,
        { lines, reason: reason.trim(), tenders: tenders.tenders },
        total
      )
      return { result, cash: tenders.tenders.some((tender) => tender.method === "cash") }
    },
    onSuccess: ({ result, cash }) => {
      for (const key of [["items"], ["item"], ["sales-today"], ["today-stats"], ["till-current"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
      onDone(result, cash)
    },
    onError: (problem) => {
      if (problem instanceof OverrideCancelled) {
        setError("Not refunded. A manager has to approve it.")
        return
      }
      setError(refusalOrFallback(problem, "That refund did not go through. Try again."))
    },
  })

  const refundable = sale.lines.some((line) => line.refundable_qty > 0)

  return (
    <>
      <SheetBody className="flex flex-col gap-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <span className="tnum font-mono text-[20px] text-foreground" data-testid="returns-sale-number">
            {sale.number}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {[when(sale.occurred_at), sale.customer?.name, formatGBP(sale.total)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>

        <div>
          <MicroLabel tone="ink" className="mb-2">
            Coming back
          </MicroLabel>
          {refundable ? null : (
            <p className="text-[15px] text-muted-foreground">
              Everything on this sale has already been refunded.
            </p>
          )}
          <ul data-testid="returns-lines">
            {sale.lines.map((line) => {
              const max = line.refundable_qty
              const value = chosen[line.id] ?? 0
              return (
                <li
                  key={line.id}
                  className="flex min-h-16 items-center gap-3 border-b border-hairline-soft py-2 first:border-t"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[16px] leading-[1.35] text-foreground">
                      {line.title}
                    </span>
                    <span className="truncate font-mono text-[13px] text-muted-foreground-2">
                      {max === 0
                        ? "Refunded"
                        : [line.sku ? displayCode(line.sku) : "", max < line.qty ? `${max} of ${line.qty} can come back` : ""]
                            .filter(Boolean)
                            .join(" · ") || "Till product"}
                    </span>
                  </span>
                  {max > 0 ? (
                    max === 1 ? (
                      <Button
                        variant="key"
                        className="min-w-24"
                        aria-pressed={value > 0}
                        aria-label={`${value > 0 ? "Keep" : "Return"} ${line.title}`}
                        onClick={() => setChosen((current) => ({ ...current, [line.id]: value > 0 ? 0 : 1 }))}
                      >
                        {value > 0 ? "Returning" : "Return"}
                      </Button>
                    ) : (
                      <Stepper
                        value={value}
                        max={max}
                        label={line.title}
                        onChange={(next) =>
                          setChosen((current) => ({
                            ...current,
                            [line.id]: Math.max(0, Math.min(max, next)),
                          }))
                        }
                      />
                    )
                  ) : null}
                  <span className="tnum w-20 shrink-0 text-right text-[16px] font-medium text-foreground">
                    {formatGBP(line.refundable_amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        <Field layout="stacked" label="Reason" htmlFor="returns-reason">
          <Input
            id="returns-reason"
            value={reason}
            containerClassName={TALL}
            placeholder="Faulty, wrong card, changed their mind"
            onChange={(event) => {
              setReason(event.target.value)
              setError(null)
            }}
          />
        </Field>

        <label className="flex min-h-14 items-center justify-between gap-6">
          <span className="text-[16px] text-foreground">Put it back in stock</span>
          <Switch checked={restock} onCheckedChange={setRestock} aria-label="Put it back in stock" />
        </label>

        <div>
          <MicroLabel tone="ink" className="mb-3">
            Back to
          </MicroLabel>
          <div role="group" aria-label="Refund to" className="grid grid-cols-3 gap-3">
            {REFUND_METHODS.map(({ method, label }) => {
              const on = methods.includes(method)
              return (
                <Button
                  key={method}
                  variant="key"
                  size="till"
                  aria-pressed={on}
                  disabled={method === "store_credit" && !sale.customer}
                  onClick={() => {
                    setError(null)
                    setMethods((current) =>
                      on
                        ? current.filter((entry) => entry !== method)
                        : [...current, method]
                    )
                  }}
                >
                  {label}
                </Button>
              )
            })}
          </div>
          {split ? (
            <div className="mt-6 flex flex-col gap-6">
              {methods.map((method) => (
                <Field
                  key={method}
                  layout="stacked"
                  label={REFUND_METHODS.find((entry) => entry.method === method)?.label}
                  htmlFor={`returns-amount-${method}`}
                >
                  <MoneyInput
                    id={`returns-amount-${method}`}
                    value={amounts[method] ?? ""}
                    containerClassName={TALL}
                    onChange={(next) => {
                      setAmounts((current) => ({ ...current, [method]: next }))
                      setError(null)
                    }}
                  />
                </Field>
              ))}
            </div>
          ) : null}
          {methods.includes("card_tide") ? (
            <div className="mt-6 flex flex-col gap-3">
              <p className="text-[15px] leading-[1.5] text-foreground">
                Refund it on the Tide reader, then record it here.
              </p>
              <Field layout="stacked" label="Card's last four digits" htmlFor="returns-last4">
                <Input
                  id="returns-last4"
                  value={last4}
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="off"
                  containerClassName={TALL}
                  className="tnum font-mono text-[20px] tracking-[0.12em]"
                  onChange={(event) => setLast4(event.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </Field>
            </div>
          ) : null}
        </div>

        {sale.tenders.length > 0 ? (
          <p className="text-[13px] leading-[1.45] text-muted-foreground">
            Paid with{" "}
            {sale.tenders
              .filter((tender) => tender.amount > 0)
              .map((tender) => `${storedTenderLabel(tender)} ${formatGBP(tender.amount)}`)
              .join(", ")}
            .
          </p>
        ) : null}

        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button
          size="till"
          data-testid="returns-refund"
          trailingArrow
          loading={refund.isPending}
          disabled={total <= 0}
          onClick={() => {
            setError(null)
            refund.mutate()
          }}
        >
          {total > 0 ? `Refund ${formatGBP(total)}` : "Refund"}
        </Button>
      </SheetFooter>
    </>
  )
}

function Refunded({
  result,
  saleId,
  cash,
  onClose,
}: {
  result: TillRefundResult
  saleId: string
  cash: boolean
  onClose: () => void
}) {
  const [problem, setProblem] = React.useState<string | null>(null)
  const [printing, setPrinting] = React.useState(false)

  // The money has to come out of the drawer for a cash refund.
  const opened = React.useRef(false)
  React.useEffect(() => {
    if (!cash || opened.current) return
    opened.current = true
    void openDrawer().then((outcome) => {
      if (!outcome.ok) setProblem(outcome.message)
    })
  }, [cash])

  return (
    <>
      <SheetBody className="flex flex-col gap-4" data-testid="returns-done">
        <p className="text-[16px] leading-[1.5] text-foreground">
          Refunded <span className="tnum font-medium">{formatGBP(result.refund.amount)}</span>.
        </p>
        <span className="tnum font-mono text-[20px] text-foreground">{result.refund.ref}</span>
        <FieldError>{problem}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button size="till" trailingArrow onClick={onClose}>
          Done
        </Button>
        <Button
          variant="text"
          className={TALL}
          loading={printing}
          onClick={async () => {
            setPrinting(true)
            const outcome = await printReceipt({ saleId, refundRef: result.refund.ref })
            setPrinting(false)
            if (!outcome.ok) setProblem(outcome.message)
          }}
        >
          Print refund receipt
        </Button>
      </SheetFooter>
    </>
  )
}

function Lookup({
  initial,
  onFound,
}: {
  initial: string
  onFound: (sale: SaleLookup) => void
}) {
  const [number, setNumber] = React.useState(initial)
  const [error, setError] = React.useState<string | null>(null)
  const find = useMutation({
    mutationFn: (value: string) => lookupSale(value),
    onSuccess: onFound,
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That sale could not be looked up. Try again.")),
  })

  const started = React.useRef(false)
  React.useEffect(() => {
    if (!initial || started.current) return
    started.current = true
    find.mutate(initial)
  }, [initial, find])

  const go = () => {
    if (!number.trim()) {
      setError("Scan the receipt, or type the sale number on it.")
      return
    }
    setError(null)
    find.mutate(number.trim())
  }

  return (
    <>
      <SheetBody>
        <Field layout="stacked" label="Sale number" htmlFor="returns-number">
          <Input
            id="returns-number"
            value={number}
            autoComplete="off"
            spellCheck={false}
            containerClassName={TALL}
            className="font-mono uppercase"
            placeholder="GG-S-000456"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setNumber(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") go()
            }}
          />
        </Field>
        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button size="till" data-testid="returns-find" trailingArrow loading={find.isPending} onClick={go}>
          Find sale
        </Button>
      </SheetFooter>
    </>
  )
}

function ReturnsFlow({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [sale, setSale] = React.useState<SaleLookup | null>(null)
  const [done, setDone] = React.useState<{ result: TillRefundResult; cash: boolean } | null>(null)

  if (done && sale) {
    return <Refunded result={done.result} saleId={sale.id} cash={done.cash} onClose={onClose} />
  }
  if (sale) return <RefundForm sale={sale} onDone={(result, cash) => setDone({ result, cash })} />
  return <Lookup initial={initial} onFound={setSale} />
}

export function ReturnsSheet({
  open,
  number,
  onOpenChange,
}: {
  open: boolean
  /** A receipt number scanned on the till, looked up as the sheet opens. */
  number: string
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-testid="returns-sheet"
        className="pb-[env(safe-area-inset-bottom)] sm:data-[side=right]:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle>Returns</SheetTitle>
          <SheetDescription>
            Scan the receipt, or find the sale by its number.
          </SheetDescription>
        </SheetHeader>
        <ReturnsFlow key={number} initial={number} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}
