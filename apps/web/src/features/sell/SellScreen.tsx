/**
 * Sell: the counter's till.
 *
 * One-handed on a phone and wedge-scanner first. The scan field is the
 * biggest thing on the page and holds focus, so an item, a customer card and
 * a reward voucher all land in the same box and are told apart by their kind
 * letter. The one primary action docks to the thumb zone.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { displayCode, formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerRing } from "@/components/ui/sticker"
import { ProductImage } from "@/components/product-image"
import { useCounterDock } from "@/app/counter-dock"
import { registerScanField } from "@/app/focus-registry"
import { setScanHandler } from "@/app/scan-bus"
import { routeScannedCode } from "@/lib/scanning/route-code"
import { refusalOrFallback } from "@/lib/api/refusal"
import { stepUp, StepUpCancelled } from "@/lib/auth-stepup"
import {
  completeSale,
  getCurrentCashSession,
  getCustomerForSale,
  getItem,
  getLoyaltySetup,
  getSale,
  getVoucher,
  listItems,
  listSales,
  refundSale,
} from "@/lib/api"
import {
  PAYMENT_LABELS,
  SPLIT_METHODS,
  checkPayment,
  lineTotal,
  pointsPreview,
  summarise,
  type BasketLine,
} from "@/features/sell/basket"
import {
  dispatchBasket,
  lineFromItem,
  useBasket,
} from "@/features/sell/basket-store"
import { CustomerSearchSheet } from "@/features/sell/CustomerSearchSheet"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { DiscountSheet, PriceSheet, RefundSheet } from "@/features/sell/sheets"
import type {
  PaymentMethod,
  RefundMethod,
  SaleDetail,
  SplitMethod,
} from "@/lib/api/types"

/** Panels own the pointer while they are open; the field must not fight them. */
const KEEPS_FOCUS =
  "input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu'], [data-slot='sheet-content'], [data-slot='dialog-content'], [data-slot='select-content'], [data-slot='menu-content']"

const PAYMENT_ORDER: PaymentMethod[] = [
  "sumup_card",
  "cash",
  "store_credit",
  "points",
  "mixed",
]

const UNDO_MS = 8000

/**
 * A blocked primary action stays legible. The shared button dims a disabled
 * control to 50 percent, which on the paper canvas lands at 1.1:1; DESIGN.md
 * asks 4.5:1 of every label, so the block goes flat grey with ink-tinted text
 * instead and the reason is spelled out above it either way.
 */
const BLOCKED =
  "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

interface DoneSale {
  id: string
  number: string
  total: number
  payment: PaymentMethod
}

function TotalRow({
  label,
  value,
  action,
  tone = "default",
}: {
  label: string
  value: string
  action?: React.ReactNode
  tone?: "default" | "muted"
}) {
  return (
    <div className="flex min-h-10 items-baseline justify-between gap-6 border-b border-hairline-soft py-3">
      <span className="flex items-baseline gap-4">
        <MicroLabel tone={tone === "muted" ? "default" : "ink"}>{label}</MicroLabel>
        {action}
      </span>
      <span
        className={
          tone === "muted"
            ? "tnum text-[15px] text-muted-foreground"
            : "tnum text-[15px] text-foreground"
        }
      >
        {value}
      </span>
    </div>
  )
}

/**
 * One method's share of a mixed payment. It keeps its own text while it is
 * being typed and only ever hands the basket whole pence, so no float ever
 * touches the split. Switching away from Mixed unmounts it, which is what
 * clears the field when the split is reset.
 */
function SplitField({ method, amount }: { method: SplitMethod; amount: number }) {
  const [text, setText] = React.useState(() => (amount ? penceToField(amount) : ""))

  return (
    <Field label={PAYMENT_LABELS[method]} htmlFor={`split-${method}`}>
      <MoneyInput
        id={`split-${method}`}
        value={text}
        onChange={(next) => {
          setText(next)
          const pence = parseDecimalToMinor(next)
          dispatchBasket({ type: "setSplit", method, amount: pence ?? 0 })
        }}
      />
    </Field>
  )
}

export function SellScreen() {
  const basket = useBasket()
  const dock = useCounterDock()
  const scanRef = React.useRef<HTMLInputElement>(null)

  const [scanError, setScanError] = React.useState<string | null>(null)
  const [scanNote, setScanNote] = React.useState<string | null>(null)
  const [customerOpen, setCustomerOpen] = React.useState(false)
  const [discountOpen, setDiscountOpen] = React.useState(false)
  const [priceLine, setPriceLine] = React.useState<BasketLine | null>(null)
  const [done, setDone] = React.useState<DoneSale | null>(null)
  const [receiptNote, setReceiptNote] = React.useState(false)
  const [undoLeft, setUndoLeft] = React.useState(0)
  const [refundSaleId, setRefundSaleId] = React.useState<string | null>(null)
  const [refundError, setRefundError] = React.useState<string | null>(null)
  const [saleError, setSaleError] = React.useState<string | null>(null)

  const { data: setup } = useQuery({
    queryKey: ["loyalty-setup"],
    queryFn: getLoyaltySetup,
    staleTime: 5 * 60_000,
  })
  const { data: cash, refetch: refetchCash } = useQuery({
    queryKey: ["cash-current"],
    queryFn: getCurrentCashSession,
    staleTime: 10_000,
  })
  const { data: todaysSales = [], refetch: refetchSales } = useQuery({
    queryKey: ["sales-today"],
    queryFn: () => listSales(10),
    staleTime: 10_000,
  })
  const { data: refundTarget } = useQuery({
    queryKey: ["sale", refundSaleId],
    queryFn: () => getSale(refundSaleId as string),
    enabled: Boolean(refundSaleId),
  })

  const totals = summarise(basket)
  const payment = checkPayment(basket, totals, {
    programme: setup?.programme,
    cashSessionOpen: Boolean(cash?.session),
  })
  const points = pointsPreview(basket, totals, setup, payment.split.points)

  // ---- The scan field ----------------------------------------------------

  const commit = React.useCallback(
    async (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      if (scanRef.current) scanRef.current.value = ""
      setScanError(null)
      setScanNote(null)
      setSaleError(null)

      const outcome = routeScannedCode(trimmed)
      try {
        if (outcome.kind === "item") {
          const item = await getItem(outcome.sku)
          if (!item) {
            setScanError(`${outcome.display} is not in stock. Check the label.`)
            return
          }
          if (item.status === "sold" || item.status === "written_off") {
            setScanError(`${item.title ?? "That item"} is no longer for sale.`)
            return
          }
          dispatchBasket({ type: "add", line: lineFromItem(item) })
          setScanNote(`${item.title ?? "Item"} added`)
          return
        }

        if (outcome.kind === "customer") {
          const customer = await getCustomerForSale(outcome.code)
          if (!customer) {
            setScanError(`${outcome.display} is not a customer here. Search by name instead.`)
            return
          }
          dispatchBasket({ type: "attachCustomer", customer })
          setScanNote(`${customer.name} attached`)
          return
        }

        if (outcome.kind === "voucher") {
          const voucher = await getVoucher(outcome.code)
          if (!voucher) {
            setScanError("That voucher has been used or has run out. Check the code.")
            return
          }
          if (!basket.customer) {
            setScanError("Scan the customer's card first, then their voucher.")
            return
          }
          if (voucher.customer !== basket.customer.id) {
            setScanError("That voucher belongs to a different customer.")
            return
          }
          dispatchBasket({ type: "applyVoucher", voucher })
          setScanNote(`${voucher.rewardName} applied`)
          return
        }

        if (outcome.kind === "ean") {
          const page = await listItems({ search: outcome.ean, status: "in_stock" }, 1)
          const hit = page.items[0]
          if (!hit) {
            setScanError("No stock has that barcode. Add it, or search by title.")
            return
          }
          const item = await getItem(hit.sku)
          if (item) {
            dispatchBasket({ type: "add", line: lineFromItem(item) })
            setScanNote(`${item.title ?? "Item"} added`)
          }
          return
        }

        setScanError(outcome.message)
      } catch (error) {
        setScanError(refusalOrFallback(error, "That code could not be looked up. Try again."))
      }
    },
    [basket.customer]
  )

  React.useEffect(() => setScanHandler((raw) => void commit(raw)), [commit])

  React.useEffect(() => {
    const field = scanRef.current
    if (!field) return undefined
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
  }, [])

  // ---- Completing --------------------------------------------------------

  const sell = useMutation({
    mutationFn: () =>
      completeSale({
        lines: basket.lines.map((line) => ({
          item: line.itemId,
          qty: line.qty,
          unit_price: line.unitPrice,
          discount: 0,
        })),
        customer: basket.customer?.id ?? null,
        payment: basket.payment,
        payment_split: payment.split,
        discount: totals.discount,
        discount_source: totals.discountSource,
        reward_code: basket.voucher?.code ?? null,
        cash_session: cash?.session?.id ?? null,
        sumup_ref: "",
      }),
    onSuccess: (result) => {
      setDone({
        id: result.sale.id,
        number: result.sale.number,
        total: result.sale.total,
        payment: basket.payment,
      })
      setUndoLeft(UNDO_MS)
      dispatchBasket({ type: "clear" })
      void refetchCash()
      void refetchSales()
    },
    onError: (error) =>
      setSaleError(refusalOrFallback(error, "That sale did not go through. Try again.")),
  })

  // The undo toast closes itself after eight seconds, and the sale stands.
  React.useEffect(() => {
    if (undoLeft <= 0) return undefined
    const timer = window.setTimeout(() => setUndoLeft(0), undoLeft)
    return () => window.clearTimeout(timer)
  }, [undoLeft])

  const undo = useMutation({
    mutationFn: async (sale: DoneSale) => {
      const full = await getSale(sale.id)
      if (!full) throw new Error("That sale is no longer on today's list.")
      const token = await stepUp()
      const method: RefundMethod =
        sale.payment === "cash"
          ? "cash"
          : sale.payment === "store_credit" || sale.payment === "points"
            ? "store_credit"
            : "sumup_card"
      return refundSale(
        sale.id,
        {
          lines: full.lines.map((line) => ({
          sale_line: line.id,
          qty: (line.qty ?? 1) - (line.refunded_qty ?? 0),
        })),
          reason: "Undone at the counter",
          refund_method: method,
        },
        token
      )
    },
    onSuccess: () => {
      setUndoLeft(0)
      setDone(null)
      void refetchCash()
      void refetchSales()
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      setSaleError(refusalOrFallback(error, "That sale could not be undone. Refund it instead."))
    },
  })

  const refund = useMutation({
    mutationFn: async ({
      sale,
      lineIds,
      method,
      reason,
    }: {
      sale: SaleDetail
      lineIds: string[]
      method: RefundMethod
      reason: string
    }) => {
      const token = await stepUp()
      return refundSale(
        sale.id,
        {
          lines: lineIds.map((id) => {
            const line = sale.lines.find((row) => row.id === id)
            return {
              sale_line: id,
              qty: (line?.qty ?? 1) - (line?.refunded_qty ?? 0),
            }
          }),
          reason,
          refund_method: method,
        },
        token
      )
    },
    onSuccess: () => {
      setRefundSaleId(null)
      setRefundError(null)
      void refetchCash()
      void refetchSales()
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      setRefundError(refusalOrFallback(error, "That refund did not go through. Try again."))
    },
  })

  const markSold = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={sell.isPending}
      disabled={!payment.ok}
      onClick={() => sell.mutate()}
    >
      Mark sold
    </Button>
  )

  // ---- The screen --------------------------------------------------------

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Sell</PageTitle>
      <Lede>Scan the items, then the customer card, then take the money.</Lede>

      <div className="mt-14">
        <Input
          ref={scanRef}
          size="scan"
          data-testid="sell-scan-field"
          leadingIcon={<BarcodeGlyph />}
          trailingHint="Press enter"
          placeholder="Scan item, card or voucher"
          aria-label="Scan an item, a customer card or a voucher"
          aria-invalid={scanError ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          onChange={() => setScanError(null)}
        />
        <FieldError>{scanError}</FieldError>
        {scanNote && !scanError ? (
          <p aria-live="polite" className="mt-2 text-[13px] text-muted-foreground">
            {scanNote}
          </p>
        ) : null}
      </div>

      {done ? (
        <div
          data-testid="sale-done"
          aria-live="polite"
          className="mt-12 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border-y border-hairline-soft py-4"
        >
          <span className="flex flex-col gap-1">
            <MicroLabel>Sold</MicroLabel>
            <span className="tnum font-mono text-[15px] text-foreground">
              {done.number}
            </span>
          </span>
          <span className="tnum font-display text-[28px] leading-none text-foreground">
            {formatGBP(done.total)}
          </span>
          <span className="flex items-center gap-8">
            <Button variant="text" onClick={() => setReceiptNote(true)}>
              Receipt
            </Button>
            <Button variant="text" onClick={() => setDone(null)}>
              New sale
            </Button>
          </span>
          {receiptNote ? (
            <p className="basis-full text-[13px] text-muted-foreground-2">
              Printed receipts arrive with the receipt screen. The sale number
              above is on the SumUp slip.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Basket ---- */}
      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Basket
        </MicroLabel>

        {basket.lines.length === 0 ? (
          <div className="flex flex-col items-start gap-6 pt-2">
            <StickerRing />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              Nothing in the basket. Scan an item to start.
            </p>
          </div>
        ) : (
          <ul data-testid="basket">
            {basket.lines.map((line) => (
              <li
                key={line.itemId}
                className="flex items-center gap-4 border-b border-hairline-soft py-3 first:border-t"
              >
                <ProductImage
                  src={line.image}
                  alt=""
                  platform={line.platform}
                  height={40}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">
                    {line.title}
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground-2">
                    {[line.detail, line.condition].filter(Boolean).join(" · ") ||
                      displayCode(line.sku)}
                  </span>
                </span>

                {line.maxQty > 1 ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost-icon"
                      aria-label={`One fewer ${line.title}`}
                      onClick={() =>
                        dispatchBasket({
                          type: "setQty",
                          itemId: line.itemId,
                          qty: line.qty - 1,
                        })
                      }
                    >
                      <span aria-hidden="true" className="text-base leading-none">
                        &minus;
                      </span>
                    </Button>
                    <span className="tnum w-6 text-center font-mono text-[13px] text-foreground">
                      {line.qty}
                    </span>
                    <Button
                      variant="ghost-icon"
                      aria-label={`One more ${line.title}`}
                      disabled={line.qty >= line.maxQty}
                      onClick={() =>
                        dispatchBasket({
                          type: "setQty",
                          itemId: line.itemId,
                          qty: line.qty + 1,
                        })
                      }
                    >
                      <span aria-hidden="true" className="text-base leading-none">
                        +
                      </span>
                    </Button>
                  </span>
                ) : null}

                <button
                  type="button"
                  onClick={() => setPriceLine(line)}
                  aria-label={`Change the price of ${line.title}`}
                  className="tnum shrink-0 text-right text-[15px] text-foreground underline-offset-4 outline-none hover:underline"
                >
                  {formatGBP(lineTotal(line))}
                  {line.unitPrice !== line.listPrice ? (
                    <span className="block font-mono text-[11px] tracking-[0.08em] text-muted-foreground-2 uppercase">
                      Was {formatGBP(line.listPrice)}
                    </span>
                  ) : null}
                </button>

                <Button
                  variant="text"
                  className="shrink-0"
                  onClick={() => dispatchBasket({ type: "remove", itemId: line.itemId })}
                >
                  <span className="sr-only">Remove {line.title}</span>
                  <span aria-hidden="true">Remove</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Customer ---- */}
      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Customer
        </MicroLabel>
        {basket.customer ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft pb-6">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[15px] text-foreground">
                {basket.customer.name}
              </span>
              <span className="tnum truncate font-mono text-[13px] text-muted-foreground-2">
                {displayCode(basket.customer.code)}
              </span>
            </span>
            {basket.customer.tierName ? (
              <Badge variant="volt">{basket.customer.tierName}</Badge>
            ) : null}
            <Hint className="tnum">
              Credit {formatGBP(basket.customer.creditBalance)}
            </Hint>
            <Hint className="tnum">
              {basket.customer.pointsBalance.toLocaleString("en-GB")} points
            </Hint>
            <Button
              variant="text"
              onClick={() => dispatchBasket({ type: "attachCustomer", customer: null })}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <p className="text-[15px] text-muted-foreground-2">
              No customer on this sale, so no points and no perks.
            </p>
            <Button variant="text" onClick={() => setCustomerOpen(true)}>
              Attach customer
            </Button>
          </div>
        )}
      </div>

      {/* ---- Totals ---- */}
      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Totals
        </MicroLabel>
        <TotalRow label="Subtotal" value={formatGBP(totals.subtotal)} tone="muted" />
        {totals.perkDiscount > 0 ? (
          <TotalRow
            label={`${basket.customer?.tierName ?? "Tier"} ${totals.perkPercent}% off`}
            value={`-${formatGBP(totals.perkDiscount)}`}
            tone="muted"
          />
        ) : null}
        {totals.voucherDiscount > 0 && basket.voucher ? (
          <>
            <TotalRow
              label={basket.voucher.rewardName}
              value={`-${formatGBP(totals.voucherDiscount)}`}
              tone="muted"
              action={
                <Button
                  variant="text"
                  onClick={() => dispatchBasket({ type: "applyVoucher", voucher: null })}
                >
                  Clear
                </Button>
              }
            />
            <p className="mt-3 text-[13px] text-muted-foreground-2">
              A reward is the whole discount on a sale, so the tier perk and any
              manual amount stand aside while it is on.
            </p>
          </>
        ) : null}
        <TotalRow
          label="Discount"
          value={
            totals.manualDiscount > 0 ? `-${formatGBP(totals.manualDiscount)}` : "None"
          }
          tone="muted"
          action={
            <Button variant="text" onClick={() => setDiscountOpen(true)}>
              Edit
            </Button>
          }
        />

        <div className="mt-6 flex items-baseline justify-between gap-6">
          <MicroLabel tone="ink">Total</MicroLabel>
          <span
            data-testid="sell-total"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(totals.total)}
          </span>
        </div>
        {basket.customer ? (
          <p className="mt-3 text-[13px] text-muted-foreground-2">
            Earns {points.toLocaleString("en-GB")} points.
          </p>
        ) : null}
      </div>

      {/* ---- Payment ---- */}
      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Payment
        </MicroLabel>
        <ChipGroup
          aria-label="Payment method"
          value={[basket.payment]}
          onValueChange={(next) => {
            const method = next[0] as PaymentMethod | undefined
            if (method) dispatchBasket({ type: "setPayment", payment: method })
          }}
        >
          {PAYMENT_ORDER.map((method) => (
            <Chip key={method} value={method}>
              {PAYMENT_LABELS[method]}
            </Chip>
          ))}
        </ChipGroup>

        {basket.payment === "mixed" ? (
          <div className="mt-8 flex flex-col gap-8">
            {SPLIT_METHODS.map((method) => (
              <SplitField key={method} method={method} amount={basket.split[method]} />
            ))}
          </div>
        ) : null}

        {payment.problems.length > 0 ? (
          <div className="mt-6 flex flex-col gap-2">
            {payment.problems.map((problem) => (
              <p key={problem} className="text-[13px] text-destructive" role="alert">
                {problem}
              </p>
            ))}
            {!cash?.session && payment.split.cash > 0 ? (
              <Button variant="text" render={<Link to="/counter/cash" />}>
                Open a session
              </Button>
            ) : null}
          </div>
        ) : null}

        {payment.sumupAmount > 0 ? (
          <div className="mt-10 flex flex-col gap-2">
            <MicroLabel tone="ink">Key this into SumUp</MicroLabel>
            <span
              data-testid="sumup-amount"
              className="tnum font-display text-[36px] leading-none tracking-[0.01em] text-foreground"
            >
              {formatGBP(payment.sumupAmount)}
            </span>
          </div>
        ) : null}

        {saleError ? (
          <p role="alert" className="mt-6 text-[13px] text-destructive">
            {saleError}
          </p>
        ) : null}

        <div className="mt-12 hidden min-[900px]:block">{markSold}</div>
      </div>

      {/* ---- Today ---- */}
      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Today
        </MicroLabel>
        {todaysSales.length === 0 ? (
          <p className="text-[15px] text-muted-foreground-2">
            Nothing sold yet today.
          </p>
        ) : (
          <ul>
            {todaysSales.map((sale) => (
              <li
                key={sale.id}
                className="border-b border-hairline-soft first:border-t"
              >
                <button
                  type="button"
                  onClick={() => {
                    setRefundError(null)
                    setRefundSaleId(sale.id)
                  }}
                  className="flex min-h-12 w-full items-center gap-4 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
                >
                  <span className="tnum shrink-0 font-mono text-[13px] text-foreground">
                    {sale.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground-2">
                    {sale.customerName ??
                      `${sale.lineCount} item${sale.lineCount === 1 ? "" : "s"}`}
                  </span>
                  {sale.status !== "complete" ? (
                    <Badge variant="outline">
                      {sale.status === "refunded" ? "Refunded" : "Part refunded"}
                    </Badge>
                  ) : null}
                  <span className="tnum shrink-0 text-[15px] text-foreground">
                    {formatGBP(sale.total)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Docked action and the undo ---- */}
      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {markSold}
            </div>,
            dock
          )
        : null}

      {done && undoLeft > 0 ? (
        <div
          role="status"
          data-testid="undo-toast"
          className="fixed inset-x-5 bottom-[calc(var(--gg-dock-h,5rem)+1rem)] z-50 mx-auto flex max-w-[480px] items-center justify-between gap-6 rounded-[var(--radius)] border border-hairline bg-popover px-5 py-4 shadow-panel min-[900px]:inset-x-auto min-[900px]:right-10 min-[900px]:bottom-10"
        >
          <span className="text-[15px] text-foreground">
            {done.number} for {formatGBP(done.total)}
          </span>
          <Button
            variant="text"
            loading={undo.isPending}
            onClick={() => undo.mutate(done)}
          >
            Undo
          </Button>
        </div>
      ) : null}

      <CustomerSearchSheet
        open={customerOpen}
        onOpenChange={setCustomerOpen}
        onChoose={(customer) => dispatchBasket({ type: "attachCustomer", customer })}
      />

      <DiscountSheet
        open={discountOpen}
        onOpenChange={setDiscountOpen}
        subtotal={totals.subtotal}
        discount={basket.manualDiscount}
        onSave={(discount) => dispatchBasket({ type: "setDiscount", discount })}
      />

      <PriceSheet
        open={Boolean(priceLine)}
        onOpenChange={(open) => {
          if (!open) setPriceLine(null)
        }}
        title={priceLine?.title ?? ""}
        listPrice={priceLine?.listPrice ?? 0}
        unitPrice={priceLine?.unitPrice ?? 0}
        onSave={(pence) => {
          if (priceLine) {
            dispatchBasket({
              type: "setUnitPrice",
              itemId: priceLine.itemId,
              unitPrice: pence,
            })
          }
          setPriceLine(null)
        }}
      />

      <RefundSheet
        open={Boolean(refundSaleId)}
        onOpenChange={(open) => {
          if (!open) setRefundSaleId(null)
        }}
        sale={refundTarget ?? null}
        pending={refund.isPending}
        error={refundError}
        onConfirm={(lineIds, method, reason) => {
          if (!refundTarget) return
          refund.mutate({ sale: refundTarget, lineIds, method, reason })
        }}
      />
    </section>
  )
}
