/**
 * The ticket (DESIGN.md, section 10, "Ticket pane"): the customer at the
 * top, the lines as hairline rows, the discount, VAT and points lines under
 * them, the total as the screen's one Anton line, and Pay as its one black
 * block with Park, Discount and Clear ticket above it.
 *
 * While the ticket is being paid for it stays where it is, read only, so
 * staff and customer can both still see what is being paid for; its total
 * drops to Jost and the Anton line moves to the tender pane.
 *
 * A part-exchange and a return (docs/api-contract-epos.md, section 7) are
 * groups of their own under the lines, each line a negative figure, and
 * the Anton total becomes what is left to pay once they are set against
 * the sale. When either is worth more than the ticket, it says so, and Pay
 * becomes Settle (a trade's surplus) or Refund (a return's difference).
 */
import * as React from "react"
import { displayCode, formatGBP } from "@gg/shared"
import { AnimatePresence, motion } from "motion/react"
import { MinusIcon, PlusIcon, UserRoundIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { underlineGrow, useMotionVariants, type ScanPulse } from "@/design/motion"
import {
  payLabel,
  surplusSentence,
  type TicketSettlement,
  type TicketTradeLine,
} from "@/features/till/exchange"
import {
  discountLabel,
  lineDiscount,
  lineNet,
  ticketIsEmpty,
  type Ticket,
  type TicketLine,
  type TicketReturn,
  type TicketTotals,
} from "@/features/till/ticket"

/** The trade group as the ticket draws it. */
export interface TicketTradeGroup {
  lines: TicketTradeLine[]
  /** V: everything the trade is worth at credit rates. */
  value: number
}

export interface TicketPaneProps {
  ticket: Ticket
  totals: TicketTotals
  /** The part-exchange on the ticket, priced, or null. */
  trade: TicketTradeGroup | null
  /** What the trade or the return leaves to pay, and how the ticket is finished. */
  settlement: TicketSettlement
  /** Points the sale earns, for the customer on it. */
  points: number
  /** Paying or done: no editing, and the total is not the Anton line. */
  readOnly: boolean
  vatRegistered: boolean
  pulsing: ScanPulse | null
  /** One sentence when an item here is also on a parked ticket. */
  clash: string | null
  /** A phone: the total and Pay live in the dock instead. */
  docked: boolean
  notice?: string | null
  onAddCustomer: () => void
  onRemoveCustomer: () => void
  onOpenLine: (line: TicketLine) => void
  onQty: (line: TicketLine, qty: number) => void
  onPark: () => void
  onDiscount: () => void
  /** Opens the Trade-in panel, asking for the customer first when there is none. */
  onTradeIn: () => void
  /** Takes the returned lines off the ticket. */
  onRemoveReturns: () => void
  onClear: () => void
  onPay: () => void
  clearing?: boolean
}

/** A negative line in the trade or return group: what it is, and what it takes off. */
function CreditRow({
  title,
  detail,
  qty,
  amount,
  testId,
}: {
  title: string
  detail: string
  qty?: number
  amount: number
  testId: string
}) {
  return (
    <li
      data-testid={testId}
      className="flex min-h-14 items-center gap-2 border-b border-hairline-soft py-2 first:border-t"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-[16px] leading-[1.35] text-foreground">{title}</span>
        {detail ? (
          <span className="truncate font-mono text-[13px] leading-[1.3] text-muted-foreground-2">
            {detail}
          </span>
        ) : null}
      </span>
      {qty && qty > 1 ? (
        <span className="tnum shrink-0 px-2 text-[15px] text-muted-foreground">&times;{qty}</span>
      ) : null}
      <span className="tnum shrink-0 pl-1 text-[16px] leading-[1.3] font-medium text-foreground">
        -{formatGBP(amount)}
      </span>
    </li>
  )
}

/** The part-exchange: "Trade-in", its lines at their credit offers, and its total. */
function TradeGroup({
  trade,
  readOnly,
  onOpen,
}: {
  trade: TicketTradeGroup
  readOnly: boolean
  onOpen: () => void
}) {
  return (
    <section aria-label="Trade-in" data-testid="ticket-trade" className="mt-6">
      <div className="flex min-h-12 items-center justify-between gap-4">
        <MicroLabel tone="ink">Trade-in</MicroLabel>
        {readOnly ? null : (
          <Button variant="text" className="min-h-12" onClick={onOpen}>
            Change
          </Button>
        )}
      </div>
      {trade.lines.length === 0 ? (
        <p className="border-t border-hairline-soft py-3 text-[15px] text-muted-foreground-2">
          Nothing on the trade-in yet.
        </p>
      ) : (
        <ul>
          {trade.lines.map((line) => (
            <CreditRow
              key={line.key}
              title={line.title}
              detail={line.detail}
              amount={line.credit}
              testId="ticket-trade-line"
            />
          ))}
        </ul>
      )}
      <div className="flex items-baseline justify-between gap-6 py-2">
        <MicroLabel>Trade-in total</MicroLabel>
        <span data-testid="ticket-trade-total" className="tnum text-[15px] text-foreground">
          -{formatGBP(trade.value)}
        </span>
      </div>
    </section>
  )
}

/** Lines of an earlier sale coming back: "Returned", the lines as negatives, the reason under them. */
function ReturnGroup({
  returns,
  readOnly,
  onRemove,
}: {
  returns: TicketReturn
  readOnly: boolean
  onRemove: () => void
}) {
  return (
    <section aria-label="Returned" data-testid="ticket-returns" className="mt-6">
      <div className="flex min-h-12 items-center justify-between gap-4">
        <MicroLabel tone="ink">Returned</MicroLabel>
        <span className="flex items-center gap-1">
          <span className="tnum font-mono text-[13px] text-muted-foreground-2">
            {returns.saleNumber}
          </span>
          {readOnly ? null : (
            <Button
              variant="ghost-icon"
              className="size-12"
              aria-label="Take the return off the ticket"
              onClick={onRemove}
            >
              <XIcon />
            </Button>
          )}
        </span>
      </div>
      <ul>
        {returns.lines.map((line) => (
          <CreditRow
            key={line.saleLine}
            title={line.title}
            detail={line.detail}
            qty={line.qty}
            amount={line.amount}
            testId="ticket-return-line"
          />
        ))}
      </ul>
      <p
        data-testid="ticket-return-reason"
        className="pt-2 text-[13px] leading-[1.45] text-muted-foreground"
      >
        {returns.reason}
      </p>
    </section>
  )
}

function CustomerRow({
  ticket,
  readOnly,
  onAdd,
  onRemove,
}: {
  ticket: Ticket
  readOnly: boolean
  onAdd: () => void
  onRemove: () => void
}) {
  const customer = ticket.customer
  if (!customer) {
    if (readOnly) {
      return <p className="text-[15px] text-muted-foreground-2">No customer on this sale.</p>
    }
    return (
      <Button variant="text" className="min-h-14" onClick={onAdd}>
        <UserRoundIcon aria-hidden="true" />
        Add customer
      </Button>
    )
  }
  return (
    <div data-testid="ticket-customer" className="flex min-w-0 flex-1 items-center gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[16px] leading-[1.3] font-medium text-foreground">
          {customer.name}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="tnum font-mono text-[13px] text-muted-foreground-2">
            {displayCode(customer.code)}
          </span>
          <span className="tnum text-[13px] text-muted-foreground">
            {customer.pointsBalance.toLocaleString("en-GB")} points
          </span>
        </span>
      </span>
      {customer.tierName ? <Badge variant="volt">{customer.tierName}</Badge> : null}
      {readOnly ? null : (
        <Button
          variant="ghost-icon"
          className="size-14"
          aria-label={`Take ${customer.name} off the ticket`}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

/** One hairline row of the ticket; the kit shows it on its own too. */
export function LineRow({
  line,
  readOnly,
  flashing,
  onOpen,
  onQty,
}: {
  line: TicketLine
  readOnly: boolean
  flashing: { nonce: number } | null
  onOpen: () => void
  onQty: (qty: number) => void
}) {
  const pulseLine = useMotionVariants(underlineGrow)
  const net = lineNet(line)
  const was = line.listPrice * line.qty
  const reduced = lineDiscount(line) > 0 || net !== was
  const meta = [line.sku ? displayCode(line.sku) : line.bookingId ? "Booking" : "Till product", line.note]
    .filter(Boolean)
    .join(" · ")

  const words = (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="line-clamp-2 text-[16px] leading-[1.35] text-foreground">{line.title}</span>
      <span className="truncate font-mono text-[13px] leading-[1.3] text-muted-foreground-2">
        {meta}
      </span>
    </span>
  )

  return (
    <li data-testid="ticket-line" className="relative border-b border-hairline-soft">
      {/* The bar a scan flashes along the row it landed on. Keyed on the
          scan rather than the row, so the same stock line scanned three
          times flashes three times. */}
      <AnimatePresence>
        {flashing ? (
          <motion.span
            key={flashing.nonce}
            aria-hidden="true"
            variants={pulseLine}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="absolute inset-x-0 -bottom-px h-[1.5px] origin-left bg-volt"
          />
        ) : null}
      </AnimatePresence>
      <div className="flex min-h-16 items-center gap-2 py-2">
        {readOnly ? (
          <span className="flex min-w-0 flex-1 items-center py-1">{words}</span>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Change ${line.title}`}
            className="-ml-2 flex min-h-14 min-w-0 flex-1 items-center rounded-[var(--radius)] px-2 py-1 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
          >
            {words}
          </button>
        )}

        {line.maxQty > 1 && !readOnly ? (
          <span className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label={`One fewer ${line.title}`}
              onClick={() => onQty(line.qty - 1)}
              className="flex size-12 items-center justify-center rounded-[var(--radius)] text-foreground outline-none transition-colors duration-150 ease-gg hover:bg-secondary focus-visible:bg-secondary"
            >
              <MinusIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
            </button>
            <span
              data-testid="ticket-line-qty"
              className="tnum w-6 text-center text-[16px] text-foreground"
            >
              {line.qty}
            </span>
            <button
              type="button"
              aria-label={`One more ${line.title}`}
              disabled={line.qty >= line.maxQty}
              onClick={() => onQty(line.qty + 1)}
              className="flex size-12 items-center justify-center rounded-[var(--radius)] text-foreground outline-none transition-colors duration-150 ease-gg hover:bg-secondary focus-visible:bg-secondary disabled:text-muted-foreground-2 disabled:hover:bg-transparent"
            >
              <PlusIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
            </button>
          </span>
        ) : line.qty > 1 ? (
          <span className="tnum shrink-0 px-2 text-[15px] text-muted-foreground">
            &times;{line.qty}
          </span>
        ) : null}

        <span className="flex shrink-0 flex-col items-end gap-0.5 pl-1">
          {reduced ? (
            <span className="tnum text-[13px] leading-none text-muted-foreground-2 line-through">
              {formatGBP(was)}
            </span>
          ) : null}
          <span
            data-testid="ticket-line-total"
            className="tnum text-[16px] leading-[1.3] font-medium text-foreground"
          >
            {formatGBP(net)}
          </span>
        </span>
      </div>
    </li>
  )
}

function SummaryRow({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <MicroLabel>{label}</MicroLabel>
      <span data-testid={testId} className="tnum text-[15px] text-foreground">
        {value}
      </span>
    </div>
  )
}

export function TicketPane({
  ticket,
  totals,
  trade,
  settlement,
  points,
  readOnly,
  vatRegistered,
  pulsing,
  clash,
  docked,
  notice,
  onAddCustomer,
  onRemoveCustomer,
  onOpenLine,
  onQty,
  onPark,
  onDiscount,
  onTradeIn,
  onRemoveReturns,
  onClear,
  onPay,
  clearing = false,
}: TicketPaneProps) {
  const empty = ticketIsEmpty(ticket)
  const surplus = surplusSentence(settlement, ticket.lines.length)
  // "To pay" once a trade or a return is set against the sale, so the
  // figure is never read as what the things on the ticket cost.
  const totalLabel = settlement.kind === "none" ? "Total" : "To pay"

  return (
    <section aria-label="Ticket" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-16 shrink-0 items-center border-b border-hairline-soft px-5">
        <CustomerRow
          ticket={ticket}
          readOnly={readOnly}
          onAdd={onAddCustomer}
          onRemove={onRemoveCustomer}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        {empty ? (
          <p data-testid="ticket-empty" className="pt-8 text-[16px] text-muted-foreground">
            Scan an item or tap a tile
          </p>
        ) : ticket.lines.length > 0 ? (
          <ul data-testid="ticket-lines">
            {ticket.lines.map((line) => (
              <LineRow
                key={line.key}
                line={line}
                readOnly={readOnly}
                flashing={pulsing?.id === line.key ? pulsing : null}
                onOpen={() => onOpenLine(line)}
                onQty={(qty) => onQty(line, qty)}
              />
            ))}
          </ul>
        ) : null}
        {trade ? <TradeGroup trade={trade} readOnly={readOnly} onOpen={onTradeIn} /> : null}
        {ticket.returns ? (
          <ReturnGroup returns={ticket.returns} readOnly={readOnly} onRemove={onRemoveReturns} />
        ) : null}
        {clash ? (
          <p role="status" className="mt-4 text-[13px] leading-[1.45] text-destructive">
            {clash}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-4 text-[13px] leading-[1.45] text-muted-foreground">
            {notice}
          </p>
        ) : null}
      </div>

      {empty ? null : (
        <div className="shrink-0 border-t border-hairline-soft px-5 pt-3 pb-5">
          {totals.discount > 0 ? (
            <SummaryRow
              label={discountLabel(ticket, totals)}
              value={`-${formatGBP(totals.discount)}`}
              testId="ticket-discount"
            />
          ) : null}
          {vatRegistered ? (
            <SummaryRow label="VAT" value={formatGBP(totals.vat)} testId="ticket-vat" />
          ) : null}
          {ticket.customer && ticket.lines.length > 0 ? (
            <SummaryRow
              label="Earns"
              value={`${points.toLocaleString("en-GB")} points`}
              testId="ticket-points"
            />
          ) : null}
          {surplus ? (
            <p
              data-testid="ticket-surplus"
              className="py-1.5 text-[15px] leading-[1.45] text-foreground"
            >
              {surplus}
            </p>
          ) : null}

          {docked ? null : readOnly ? (
            <div className="flex items-baseline justify-between gap-6 pt-3">
              <MicroLabel tone="ink">{totalLabel}</MicroLabel>
              <span
                data-testid="ticket-total"
                className="tnum text-[20px] leading-none font-medium text-foreground"
              >
                {formatGBP(settlement.toPay)}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-6 pt-3">
                <MicroLabel tone="ink" className="pb-1">
                  {totalLabel}
                </MicroLabel>
                <span
                  data-testid="ticket-total"
                  className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
                >
                  {formatGBP(settlement.toPay)}
                </span>
              </div>
              <TicketActions
                onPark={onPark}
                onDiscount={onDiscount}
                onTradeIn={onTradeIn}
                onClear={onClear}
                clearing={clearing}
                className="mt-3"
              />
              <Button
                size="till"
                data-testid="till-pay"
                className="mt-2 w-full"
                trailingArrow
                onClick={onPay}
              >
                {payLabel(settlement)}
              </Button>
            </>
          )}
          {docked && !readOnly ? (
            <TicketActions
              onPark={onPark}
              onDiscount={onDiscount}
              onTradeIn={onTradeIn}
              onClear={onClear}
              clearing={clearing}
              className="mt-2"
            />
          ) : null}
        </div>
      )}
    </section>
  )
}

function TicketActions({
  onPark,
  onDiscount,
  onTradeIn,
  onClear,
  clearing,
  className,
}: {
  onPark: () => void
  onDiscount: () => void
  onTradeIn: () => void
  onClear: () => void
  clearing: boolean
  className?: string
}) {
  // Two presses to throw a whole ticket away: one tap by a stray thumb
  // would lose somebody's basket and log every line as a void.
  const [asking, setAsking] = React.useState(false)

  if (asking || clearing) {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-8", className)} role="group" aria-label="Clear ticket">
        <span className="text-[15px] text-foreground">Clear every line?</span>
        <Button
          variant="text-destructive"
          className="min-h-14"
          loading={clearing}
          data-testid="till-clear-confirm"
          onClick={() => {
            setAsking(false)
            onClear()
          }}
        >
          Yes, clear it
        </Button>
        <Button variant="text" className="ml-auto min-h-14" disabled={clearing} onClick={() => setAsking(false)}>
          Keep it
        </Button>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-x-5", className)}>
      <Button variant="text" className="min-h-14" onClick={onPark}>
        Park
      </Button>
      <Button variant="text" className="min-h-14" onClick={onDiscount}>
        Discount
      </Button>
      <Button variant="text" className="min-h-14" data-testid="till-trade-in" onClick={onTradeIn}>
        Trade in
      </Button>
      <Button variant="text" className="ml-auto min-h-14" onClick={() => setAsking(true)}>
        Clear ticket
      </Button>
    </div>
  )
}
