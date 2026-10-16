/**
 * The till's sheets: a line (quantity, discount, price, note, remove), the
 * ticket discount, the price of an open-price key, parking a ticket and
 * recalling one. Everything secondary is a sheet (DESIGN.md, section 4),
 * docked to the bottom on a phone.
 *
 * Each form is a child of `SheetContent`, which Base UI mounts only while
 * the sheet is open, so its fields start fresh every time without an effect
 * reaching in to clear them.
 */
import * as React from "react"
import {
  formatGBP,
  parseDecimalToMinor,
  type TillCatalogueProduct,
} from "@gg/shared"
import { MinusIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatPercent } from "@/lib/format"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { AmountPad } from "@/features/till/AmountPad"
import { digitsToPence } from "@/features/till/icons"
import {
  adjustmentAmount,
  lineGross,
  type Adjustment,
  type LinePatch,
  type TicketLine,
} from "@/features/till/ticket"
import type { ParkedTicket } from "@/lib/api/till"

const SHEET = "pb-[env(safe-area-inset-bottom)]"
const TALL = "min-h-14"

// ---------------------------------------------------------------------------
// A discount, in pounds or as a percentage
// ---------------------------------------------------------------------------

function adjustmentText(adjustment: Adjustment): string {
  if (adjustment.kind === "amount") return penceToField(adjustment.value)
  if (adjustment.kind === "percent") return String(adjustment.value)
  return ""
}

/** The typed discount, or the sentence that says what is wrong with it. */
function readAdjustment(
  mode: "amount" | "percent",
  text: string,
  of: number,
  what: string
): { ok: true; value: Adjustment } | { ok: false; message: string } {
  if (!text.trim()) return { ok: true, value: { kind: "none" } }
  if (mode === "amount") {
    const pence = parseDecimalToMinor(text)
    if (pence === null || pence < 0) {
      return { ok: false, message: "Key the discount in pounds and pence, for example 2.50." }
    }
    if (pence > of) {
      return {
        ok: false,
        message: `That is more than ${what}. The most you can take off is ${formatGBP(of)}.`,
      }
    }
    return { ok: true, value: pence === 0 ? { kind: "none" } : { kind: "amount", value: pence } }
  }
  const percent = Number(text)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { ok: false, message: "Key a percentage between 0 and 100." }
  }
  return { ok: true, value: percent === 0 ? { kind: "none" } : { kind: "percent", value: percent } }
}

function DiscountFields({
  idPrefix,
  mode,
  text,
  invalid,
  onMode,
  onText,
}: {
  idPrefix: string
  mode: "amount" | "percent"
  text: string
  invalid: boolean
  onMode: (mode: "amount" | "percent") => void
  onText: (text: string) => void
}) {
  return (
    <>
      <ChipGroup
        aria-label="Discount in"
        value={[mode]}
        onValueChange={(next) => {
          const chosen = next[0]
          if (chosen === "amount" || chosen === "percent") onMode(chosen)
        }}
        className="mb-6"
      >
        <Chip value="amount" className="h-12 px-5">
          Pounds
        </Chip>
        <Chip value="percent" className="h-12 px-5">
          Percent
        </Chip>
      </ChipGroup>
      <Field
        layout="stacked"
        label={mode === "amount" ? "Amount off" : "Percent off"}
        htmlFor={`${idPrefix}-discount`}
      >
        {mode === "amount" ? (
          <MoneyInput
            id={`${idPrefix}-discount`}
            value={text}
            invalid={invalid}
            containerClassName={TALL}
            onChange={onText}
          />
        ) : (
          <Input
            id={`${idPrefix}-discount`}
            inputMode="decimal"
            className="tnum"
            containerClassName={TALL}
            trailingHint="Percent"
            aria-invalid={invalid || undefined}
            value={text}
            onChange={(event) => onText(event.target.value)}
          />
        )}
      </Field>
    </>
  )
}

function overLimit(amount: number, of: number, limitPct: number): boolean {
  return of > 0 && amount * 100 > of * limitPct
}

function LimitNote({ limitPct }: { limitPct: number }) {
  return (
    <p className="mt-4 text-[13px] leading-[1.45] text-muted-foreground">
      That is over the {formatPercent(limitPct)} limit. A manager approves it when the sale
      goes through, if your role cannot.
    </p>
  )
}

// ---------------------------------------------------------------------------
// A line
// ---------------------------------------------------------------------------

function LineForm({
  line,
  limitPct,
  onSave,
  onRemove,
}: {
  line: TicketLine
  limitPct: number
  onSave: (patch: LinePatch) => void
  onRemove: () => void
}) {
  const [qty, setQty] = React.useState(line.qty)
  const [price, setPrice] = React.useState(() => penceToField(line.unitPrice))
  const [mode, setMode] = React.useState<"amount" | "percent">(
    line.discount.kind === "percent" ? "percent" : "amount"
  )
  const [discount, setDiscount] = React.useState(() => adjustmentText(line.discount))
  const [note, setNote] = React.useState(line.note)
  const [error, setError] = React.useState<string | null>(null)

  const pence = parseDecimalToMinor(price)
  const gross = lineGross({ unitPrice: pence ?? line.unitPrice, qty })
  const typed = readAdjustment(mode, discount, gross, "the line")
  const off = typed.ok ? adjustmentAmount(typed.value, gross) : 0

  function save() {
    if (pence === null || pence < 0) {
      setError("Key the price in pounds and pence, for example 12.50.")
      return
    }
    if (!typed.ok) {
      setError(typed.message)
      return
    }
    onSave({ qty, unitPrice: pence, discount: typed.value, note })
  }

  return (
    <>
      <SheetBody className="flex flex-col gap-8">
        {line.maxQty > 1 ? (
          <div>
            <span className="block font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase">
              Quantity
            </span>
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="key"
                className="size-14 px-0"
                aria-label="One fewer"
                disabled={qty <= 1}
                onClick={() => setQty((value) => Math.max(1, value - 1))}
              >
                <MinusIcon aria-hidden="true" />
              </Button>
              <span data-testid="line-sheet-qty" className="tnum w-14 text-center text-[24px] font-light">
                {qty}
              </span>
              <Button
                variant="key"
                className="size-14 px-0"
                aria-label="One more"
                disabled={qty >= line.maxQty}
                onClick={() => setQty((value) => Math.min(line.maxQty, value + 1))}
              >
                <PlusIcon aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}

        <div>
          <Field layout="stacked" label="Price each" htmlFor="line-price">
            <MoneyInput
              id="line-price"
              value={price}
              invalid={pence === null}
              containerClassName={TALL}
              onChange={(next) => {
                setPrice(next)
                setError(null)
              }}
            />
          </Field>
          <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground">
            {line.openPrice
              ? "Keyed at the till."
              : `Ticket price ${formatGBP(line.listPrice)}. A change may need a manager to approve it.`}
          </p>
        </div>

        <div>
          <DiscountFields
            idPrefix="line"
            mode={mode}
            text={discount}
            invalid={!typed.ok}
            onMode={setMode}
            onText={(next) => {
              setDiscount(next)
              setError(null)
            }}
          />
          {overLimit(off, gross, limitPct) ? <LimitNote limitPct={limitPct} /> : null}
        </div>

        <Field layout="stacked" label="Note" htmlFor="line-note">
          <Input
            id="line-note"
            value={note}
            maxLength={200}
            containerClassName={TALL}
            placeholder="Shown on the receipt"
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button size="till" data-testid="line-sheet-save" trailingArrow onClick={save}>
          Save line
        </Button>
        <Button variant="text-destructive" className={TALL} onClick={onRemove}>
          Remove from the ticket
        </Button>
      </SheetFooter>
    </>
  )
}

export function LineSheet({
  line,
  limitPct,
  onOpenChange,
  onSave,
  onRemove,
}: {
  line: TicketLine | null
  limitPct: number
  onOpenChange: (open: boolean) => void
  onSave: (line: TicketLine, patch: LinePatch) => void
  onRemove: (line: TicketLine) => void
}) {
  return (
    <Sheet open={Boolean(line)} onOpenChange={onOpenChange}>
      <SheetContent className={SHEET} data-testid="line-sheet">
        <SheetHeader>
          <SheetTitle>Line</SheetTitle>
          <SheetDescription>{line?.title ?? ""}</SheetDescription>
        </SheetHeader>
        {line ? (
          <LineForm
            line={line}
            limitPct={limitPct}
            onSave={(patch) => onSave(line, patch)}
            onRemove={() => onRemove(line)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// The ticket discount
// ---------------------------------------------------------------------------

function TicketDiscountForm({
  subtotal,
  discount,
  limitPct,
  onSave,
}: {
  subtotal: number
  discount: Adjustment
  limitPct: number
  onSave: (next: Adjustment) => void
}) {
  const [mode, setMode] = React.useState<"amount" | "percent">(
    discount.kind === "percent" ? "percent" : "amount"
  )
  const [text, setText] = React.useState(() => adjustmentText(discount))
  const [error, setError] = React.useState<string | null>(null)
  const typed = readAdjustment(mode, text, subtotal, "the ticket")
  const off = typed.ok ? adjustmentAmount(typed.value, subtotal) : 0

  return (
    <>
      <SheetBody>
        <DiscountFields
          idPrefix="ticket"
          mode={mode}
          text={text}
          invalid={Boolean(error)}
          onMode={setMode}
          onText={(next) => {
            setText(next)
            setError(null)
          }}
        />
        {overLimit(off, subtotal, limitPct) ? <LimitNote limitPct={limitPct} /> : null}
        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button
          size="till"
          data-testid="discount-sheet-apply"
          trailingArrow
          onClick={() => {
            if (!typed.ok) {
              setError(typed.message)
              return
            }
            onSave(typed.value)
          }}
        >
          Apply discount
        </Button>
        <Button variant="text" className={TALL} onClick={() => onSave({ kind: "none" })}>
          No discount
        </Button>
      </SheetFooter>
    </>
  )
}

export function TicketDiscountSheet({
  open,
  onOpenChange,
  subtotal,
  discount,
  limitPct,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subtotal: number
  discount: Adjustment
  limitPct: number
  onSave: (next: Adjustment) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={SHEET}>
        <SheetHeader>
          <SheetTitle>Discount</SheetTitle>
          <SheetDescription>
            Off the whole ticket, on top of any tier perk.
          </SheetDescription>
        </SheetHeader>
        <TicketDiscountForm
          subtotal={subtotal}
          discount={discount}
          limitPct={limitPct}
          onSave={(next) => {
            onSave(next)
            onOpenChange(false)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// An open-price key
// ---------------------------------------------------------------------------

function KeyPriceForm({
  product,
  onAdd,
}: {
  product: TillCatalogueProduct
  onAdd: (price: number, detail: string) => void
}) {
  const [digits, setDigits] = React.useState("")
  const [detail, setDetail] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const add = () => {
    const price = digitsToPence(digits)
    if (price <= 0) {
      setError(`Key a price for ${product.name}.`)
      return
    }
    onAdd(price, detail)
  }
  return (
    <>
      <SheetBody className="flex flex-col gap-8">
        <AmountPad
          label="Price"
          value={digits}
          onChange={(next) => {
            setDigits(next)
            setError(null)
          }}
          onEnter={add}
          invalid={Boolean(error)}
          testId="key-price-amount"
          stacked
        />
        <Field layout="stacked" label="What it is" hint="Optional" htmlFor="key-price-detail">
          <Input
            id="key-price-detail"
            value={detail}
            maxLength={80}
            containerClassName={TALL}
            placeholder={product.name === "Single card" ? "Charizard ex" : "For the receipt"}
            onChange={(event) => setDetail(event.target.value)}
          />
        </Field>
        <FieldError>{error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button size="till" data-testid="key-price-add" trailingArrow onClick={add}>
          Add to ticket
        </Button>
      </SheetFooter>
    </>
  )
}

export function KeyPriceSheet({
  product,
  onOpenChange,
  onAdd,
}: {
  product: TillCatalogueProduct | null
  onOpenChange: (open: boolean) => void
  onAdd: (product: TillCatalogueProduct, price: number, detail: string) => void
}) {
  return (
    <Sheet open={Boolean(product)} onOpenChange={onOpenChange}>
      <SheetContent className={SHEET} data-testid="key-price-sheet">
        <SheetHeader>
          <SheetTitle>Key price</SheetTitle>
          <SheetDescription>{product?.name ?? ""}</SheetDescription>
        </SheetHeader>
        {product ? (
          <KeyPriceForm product={product} onAdd={(price, detail) => onAdd(product, price, detail)} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Parking and recalling
// ---------------------------------------------------------------------------

function ParkForm({
  suggested,
  pending,
  error,
  onPark,
}: {
  suggested: string
  pending: boolean
  error: string | null
  onPark: (label: string) => void
}) {
  const [label, setLabel] = React.useState(suggested)
  const [problem, setProblem] = React.useState<string | null>(null)
  const park = () => {
    if (!label.trim()) {
      setProblem("Give the ticket a name so it can be found again.")
      return
    }
    onPark(label.trim())
  }
  return (
    <>
      <SheetBody>
        <Field layout="stacked" label="Name" htmlFor="park-label">
          <Input
            id="park-label"
            value={label}
            maxLength={60}
            autoComplete="off"
            containerClassName={TALL}
            aria-invalid={problem || error ? true : undefined}
            onChange={(event) => {
              setLabel(event.target.value)
              setProblem(null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") park()
            }}
          />
        </Field>
        <FieldError>{problem ?? error}</FieldError>
      </SheetBody>
      <SheetFooter>
        <Button size="till" data-testid="park-sheet-park" trailingArrow loading={pending} onClick={park}>
          Park ticket
        </Button>
      </SheetFooter>
    </>
  )
}

export function ParkSheet({
  open,
  onOpenChange,
  suggested,
  pending,
  error,
  onPark,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suggested: string
  pending: boolean
  error: string | null
  onPark: (label: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={SHEET}>
        <SheetHeader>
          <SheetTitle>Park ticket</SheetTitle>
          <SheetDescription>
            It waits on the server, so either till can pick it up.
          </SheetDescription>
        </SheetHeader>
        <ParkForm suggested={suggested} pending={pending} error={error} onPark={onPark} />
      </SheetContent>
    </Sheet>
  )
}

function timeOf(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

export function RecallSheet({
  open,
  onOpenChange,
  tickets,
  loading,
  blocked,
  pendingId,
  error,
  onRecall,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tickets: ParkedTicket[]
  loading: boolean
  /** The till already has a ticket on it. */
  blocked: boolean
  pendingId: string | null
  error: string | null
  onRecall: (ticket: ParkedTicket) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={SHEET} data-testid="recall-sheet">
        <SheetHeader>
          <SheetTitle>Parked tickets</SheetTitle>
          <SheetDescription>
            {blocked
              ? "Park or clear the ticket on the till before recalling another."
              : "Tap one to put it back on the till."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {tickets.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              {loading ? "Fetching the parked tickets." : "Nothing is parked on this till."}
            </p>
          ) : (
            <ul>
              {tickets.map((ticket) => {
                const count = Array.isArray((ticket.payload as { lines?: unknown[] })?.lines)
                  ? ((ticket.payload as { lines: unknown[] }).lines.length)
                  : 0
                return (
                  <li key={ticket.id} className="border-b border-hairline-soft first:border-t">
                    <button
                      type="button"
                      data-testid="parked-ticket"
                      disabled={blocked || pendingId !== null}
                      onClick={() => onRecall(ticket)}
                      className="flex min-h-16 w-full items-center gap-4 py-3 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[16px] font-medium text-foreground">
                          {ticket.label}
                        </span>
                        <span className="tnum font-mono text-[13px] text-muted-foreground-2">
                          {count === 1 ? "1 line" : `${count} lines`}
                          {ticket.created ? ` · ${timeOf(ticket.created)}` : ""}
                        </span>
                      </span>
                      <span className="tnum text-[16px] font-medium text-foreground">
                        {formatGBP(ticket.total)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <FieldError>{error}</FieldError>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
