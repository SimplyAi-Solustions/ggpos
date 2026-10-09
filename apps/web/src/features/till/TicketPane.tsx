/**
 * The ticket (DESIGN.md, section 10, "Ticket pane"): the customer at the
 * top, the lines as hairline rows, the discount, VAT and points lines under
 * them, the total as the screen's one Anton line, and Pay as its one black
 * block with Park, Discount and Clear ticket above it.
 *
 * While the ticket is being paid for it stays where it is, read only, so
 * staff and customer can both still see what is being paid for; its total
 * drops to Jost and the Anton line moves to the tender pane.
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
  discountLabel,
  lineDiscount,
  lineNet,
  type Ticket,
  type TicketLine,
  type TicketTotals,
} from "@/features/till/ticket"

export interface TicketPaneProps {
  ticket: Ticket
  totals: TicketTotals
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
  onClear: () => void
  onPay: () => void
  clearing?: boolean
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
  const meta = [line.sku ? displayCode(line.sku) : "Till product", line.note]
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
  onClear,
  onPay,
  clearing = false,
}: TicketPaneProps) {
  const empty = ticket.lines.length === 0

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
        ) : (
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
        )}
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
          {ticket.customer ? (
            <SummaryRow
              label="Earns"
              value={`${points.toLocaleString("en-GB")} points`}
              testId="ticket-points"
            />
          ) : null}

          {docked ? null : readOnly ? (
            <div className="flex items-baseline justify-between gap-6 pt-3">
              <MicroLabel tone="ink">Total</MicroLabel>
              <span
                data-testid="ticket-total"
                className="tnum text-[20px] leading-none font-medium text-foreground"
              >
                {formatGBP(totals.total)}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-6 pt-3">
                <MicroLabel tone="ink" className="pb-1">
                  Total
                </MicroLabel>
                <span
                  data-testid="ticket-total"
                  className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
                >
                  {formatGBP(totals.total)}
                </span>
              </div>
              <TicketActions
                onPark={onPark}
                onDiscount={onDiscount}
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
                Pay
              </Button>
            </>
          )}
          {docked && !readOnly ? (
            <TicketActions
              onPark={onPark}
              onDiscount={onDiscount}
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
  onClear,
  clearing,
  className,
}: {
  onPark: () => void
  onDiscount: () => void
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
    <div className={cn("flex items-center gap-8", className)}>
      <Button variant="text" className="min-h-14" onClick={onPark}>
        Park
      </Button>
      <Button variant="text" className="min-h-14" onClick={onDiscount}>
        Discount
      </Button>
      <Button variant="text" className="ml-auto min-h-14" onClick={() => setAsking(true)}>
        Clear ticket
      </Button>
    </div>
  )
}
