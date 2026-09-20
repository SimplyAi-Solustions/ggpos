/**
 * The Sell screen's bottom sheets: the unit price on a line, the manual
 * discount, and the refund picker. Everything secondary on a phone is a
 * sheet, per DESIGN.md.
 */
import * as React from "react"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { MoneyInput, penceToField } from "@/features/sell/money-input"
import type { ManualDiscount } from "@/features/sell/basket"
import type { RefundMethod, SaleDetail } from "@/lib/api/types"

// ---------------------------------------------------------------------------
// Unit price
// ---------------------------------------------------------------------------

export function PriceSheet({
  open,
  onOpenChange,
  title,
  listPrice,
  unitPrice,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  listPrice: number
  unitPrice: number
  onSave: (pence: number) => void
}) {
  const [value, setValue] = React.useState(penceToField(unitPrice))
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setValue(penceToField(unitPrice))
      setError(null)
    }
  }, [open, unitPrice])

  function save() {
    const pence = parseDecimalToMinor(value)
    if (pence === null || pence < 0) {
      setError("Enter the price in pounds and pence, for example 12.50.")
      return
    }
    onSave(pence)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Price</SheetTitle>
          <SheetDescription>{title}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Field layout="stacked" label="Unit price" htmlFor="sell-unit-price">
            <MoneyInput
              id="sell-unit-price"
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
          <p className="mt-4 text-[13px] text-muted-foreground-2">
            Ticket price {formatGBP(listPrice)}. A change is recorded against the sale.
          </p>
        </SheetBody>
        <SheetFooter>
          <Button onClick={save} trailingArrow>
            Save price
          </Button>
          <Button variant="text" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Manual discount
// ---------------------------------------------------------------------------

export function DiscountSheet({
  open,
  onOpenChange,
  subtotal,
  discount,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subtotal: number
  discount: ManualDiscount
  onSave: (next: ManualDiscount) => void
}) {
  const [mode, setMode] = React.useState<"amount" | "percent">(
    discount.kind === "percent" ? "percent" : "amount"
  )
  const [value, setValue] = React.useState(
    discount.kind === "none" ? "" : discount.kind === "amount" ? penceToField(discount.value) : String(discount.value)
  )
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setMode(discount.kind === "percent" ? "percent" : "amount")
    setValue(
      discount.kind === "none"
        ? ""
        : discount.kind === "amount"
          ? penceToField(discount.value)
          : String(discount.value)
    )
    setError(null)
  }, [open, discount])

  function save() {
    if (!value.trim()) {
      onSave({ kind: "none" })
      onOpenChange(false)
      return
    }
    if (mode === "amount") {
      const pence = parseDecimalToMinor(value)
      if (pence === null || pence < 0) {
        setError("Enter the discount in pounds and pence, for example 2.50.")
        return
      }
      if (pence > subtotal) {
        setError(`That is more than the basket. The most you can take off is ${formatGBP(subtotal)}.`)
        return
      }
      onSave({ kind: "amount", value: pence })
    } else {
      const percent = Number(value)
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        setError("Enter a percentage between 0 and 100.")
        return
      }
      onSave({ kind: "percent", value: percent })
    }
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Discount</SheetTitle>
          <SheetDescription>
            Taken off the whole basket, on top of any tier perk.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <ChipGroup
            aria-label="Discount type"
            value={[mode]}
            onValueChange={(next) => {
              const chosen = next[0]
              if (chosen === "amount" || chosen === "percent") setMode(chosen)
            }}
            className="mb-8"
          >
            <Chip value="amount">Pounds</Chip>
            <Chip value="percent">Percent</Chip>
          </ChipGroup>

          <Field
            layout="stacked"
            label={mode === "amount" ? "Amount off" : "Percent off"}
            htmlFor="sell-discount"
          >
            {mode === "amount" ? (
              <MoneyInput
                id="sell-discount"
                autoFocus
                value={value}
                onChange={(next) => {
                  setValue(next)
                  setError(null)
                }}
                invalid={Boolean(error)}
              />
            ) : (
              <Input
                id="sell-discount"
                autoFocus
                inputMode="decimal"
                className="tnum"
                trailingHint="Percent"
                aria-invalid={error ? true : undefined}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value)
                  setError(null)
                }}
              />
            )}
          </Field>
          <FieldError>{error}</FieldError>
        </SheetBody>
        <SheetFooter>
          <Button onClick={save} trailingArrow>
            Apply discount
          </Button>
          <Button
            variant="text"
            onClick={() => {
              onSave({ kind: "none" })
              onOpenChange(false)
            }}
          >
            Clear
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

const REFUND_METHODS: { value: RefundMethod; label: string }[] = [
  { value: "sumup_card", label: "SumUp card" },
  { value: "cash", label: "Cash" },
  { value: "store_credit", label: "Store credit" },
]

export function RefundSheet({
  open,
  onOpenChange,
  sale,
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sale: SaleDetail | null
  pending: boolean
  error: string | null
  onConfirm: (lineIds: string[], method: RefundMethod, reason: string) => void
}) {
  const [chosen, setChosen] = React.useState<string[]>([])
  const [method, setMethod] = React.useState<RefundMethod>("sumup_card")
  const [reason, setReason] = React.useState("")

  const refundable = React.useMemo(
    () => sale?.lines.filter((line) => line.status !== "refunded") ?? [],
    [sale]
  )

  React.useEffect(() => {
    if (!open) return
    setChosen(refundable.map((line) => line.id))
    setMethod(
      sale?.payment === "cash"
        ? "cash"
        : sale?.payment === "store_credit"
          ? "store_credit"
          : "sumup_card"
    )
    setReason("")
  }, [open, refundable, sale])

  const total = refundable
    .filter((line) => chosen.includes(line.id))
    .reduce((sum, line) => sum + (line.unit_price ?? 0) * (line.qty ?? 1) - (line.discount ?? 0), 0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Refund</SheetTitle>
          <SheetDescription>
            {sale ? `Sale ${sale.number}. Choose the lines going back.` : ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {refundable.length === 0 ? (
            <p className="text-[15px] text-muted-foreground-2">
              Every line on this sale has already been refunded.
            </p>
          ) : (
            <ul className="border-t border-hairline-soft">
              {refundable.map((line) => {
                const on = chosen.includes(line.id)
                return (
                  <li key={line.id} className="border-b border-hairline-soft">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setChosen((current) =>
                          on
                            ? current.filter((id) => id !== line.id)
                            : [...current, line.id]
                        )
                      }
                      className="flex min-h-14 w-full items-center gap-4 text-left"
                    >
                      <span
                        aria-hidden="true"
                        className={`size-4 shrink-0 border ${on ? "border-foreground bg-foreground" : "border-hairline"}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">
                        {line.title}
                      </span>
                      <span className="tnum shrink-0 text-[15px] text-foreground">
                        {formatGBP((line.unit_price ?? 0) * (line.qty ?? 1))}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <MicroLabel tone="ink" className="mt-10 mb-4">
            Back to
          </MicroLabel>
          <ChipGroup
            aria-label="Refund method"
            value={[method]}
            onValueChange={(next) => {
              const chosenMethod = next[0] as RefundMethod | undefined
              if (chosenMethod) setMethod(chosenMethod)
            }}
          >
            {REFUND_METHODS.map((entry) => (
              <Chip key={entry.value} value={entry.value}>
                {entry.label}
              </Chip>
            ))}
          </ChipGroup>

          <Field
            layout="stacked"
            label="Reason"
            htmlFor="refund-reason"
            className="mt-10"
          >
            <Input
              id="refund-reason"
              value={reason}
              placeholder="Faulty, wrong card, changed their mind"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <FieldError>{error}</FieldError>

          <div className="mt-10 flex items-baseline justify-between gap-4">
            <MicroLabel tone="ink">Refunding</MicroLabel>
            <span className="tnum font-display text-[28px] leading-none text-foreground">
              {formatGBP(total)}
            </span>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            loading={pending}
            disabled={chosen.length === 0}
            trailingArrow
            onClick={() => onConfirm(chosen, method, reason)}
          >
            Refund
          </Button>
          <Button variant="text" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Hint>Needs your password</Hint>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
