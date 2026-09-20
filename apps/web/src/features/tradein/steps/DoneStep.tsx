import * as React from "react"
import { motion } from "motion/react"
import { displayCode, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import { ProductImage } from "@/components/product-image"
import { listContainer, listItem, useMotionVariants } from "@/design/motion"
import type { Payout, TradeLine } from "@/features/tradein/machine"

export interface DoneStepProps {
  number: string
  labels: number
  points: number
  items: { id: string; sku: string; title: string }[]
  lines: TradeLine[]
  payout: Payout
  customerEmail: string
  onReceipt: () => void
  onPrintLabels: () => void
  onEmailReceipt: () => void
  onNewBuyIn: () => void
  emailNote: string | null
  emailBusy: boolean
  /** Shown after "Print labels": the queue is the server's, not this screen's. */
  labelNote: string | null
}

/**
 * The seal.
 *
 * Nothing on this screen asks for anything: the buy-in is done, the items
 * exist, the labels are queued and the customer is owed what they are owed.
 * The item cards fan in at 20ms apart, which is the system's list stagger
 * and the only motion here.
 */
export function DoneStep({
  number,
  labels,
  points,
  items,
  lines,
  payout,
  customerEmail,
  onReceipt,
  onPrintLabels,
  onEmailReceipt,
  onNewBuyIn,
  emailNote,
  emailBusy,
  labelNote,
}: DoneStepProps) {
  const container = useMotionVariants(listContainer)
  const item = useMotionVariants(listItem)

  // The art for a finished item comes from the line it was made from; a line
  // without a card picture shows the silhouette frame, not a gap.
  const art = React.useMemo(() => {
    const images = lines.filter((line) => line.accepted).map((line) => line.image)
    return items.map((_, index) => images[index] ?? images[0])
  }, [items, lines])

  return (
    <section aria-live="polite">
      <Seal tick />
      <PageTitle className="mt-10">Bought in</PageTitle>
      <p
        data-testid="buyin-number"
        className="tnum mt-4 font-mono text-[28px] leading-none text-foreground"
      >
        {number}
      </p>

      <div className="mt-8 flex flex-wrap items-end gap-x-14 gap-y-6">
        {payout.cash > 0 ? (
          <div>
            <MicroLabel className="mb-2">Cash out</MicroLabel>
            <p className="tnum font-mono text-[20px] leading-none text-foreground">
              {formatGBP(payout.cash)}
            </p>
          </div>
        ) : null}
        {payout.credit > 0 ? (
          <div>
            <MicroLabel className="mb-2">Credit added</MicroLabel>
            <p className="tnum font-mono text-[20px] leading-none text-foreground">
              {formatGBP(payout.credit)}
            </p>
          </div>
        ) : null}
        {points > 0 ? (
          <div>
            <MicroLabel className="mb-2">Points earned</MicroLabel>
            <p className="tnum font-mono text-[20px] leading-none text-foreground">
              {points.toLocaleString("en-GB")}
            </p>
          </div>
        ) : null}
      </div>

      <motion.ul
        initial="hidden"
        animate="visible"
        variants={container}
        className="mt-14 flex flex-wrap items-end gap-x-4 gap-y-6"
        aria-label="Items now in stock"
      >
        {items.map((created, index) => (
          <motion.li
            key={created.id}
            variants={item}
            className="flex w-[104px] flex-col gap-2"
          >
            <ProductImage src={art[index]} alt="" platform="tcg_card" height={104} />
            <span className="tnum font-mono text-[11px] leading-[1.4] text-muted-foreground">
              {displayCode(created.sku)}
            </span>
          </motion.li>
        ))}
      </motion.ul>

      <p className="mt-12 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
        {labels} {labels === 1 ? "label" : "labels"} queued for the counter
        printer.
      </p>

      <div className="mt-12 flex flex-wrap items-center gap-x-10 gap-y-5">
        <Button type="button" trailingArrow onClick={onNewBuyIn}>
          New buy-in
        </Button>
        <Button variant="text" type="button" onClick={onPrintLabels}>
          Print labels
        </Button>
        <Button variant="text" type="button" onClick={onReceipt}>
          Receipt
        </Button>
        {customerEmail ? (
          <Button
            variant="text"
            type="button"
            loading={emailBusy}
            onClick={onEmailReceipt}
          >
            Email receipt
          </Button>
        ) : null}
        {emailNote ? <Hint aria-live="polite">{emailNote}</Hint> : null}
        {labelNote ? <Hint aria-live="polite">{labelNote}</Hint> : null}
      </div>
    </section>
  )
}
