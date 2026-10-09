/**
 * Done (DESIGN.md, section 10, "Paying"): the seal, the change as the
 * screen's Anton line when there is change (otherwise the sale number as the
 * outcome code), the points the sale earned, the four receipt choices and
 * "New sale". Choosing a receipt starts the next sale; a printer or mail
 * that would not take it is one line under the choices, never a blocker.
 */
import * as React from "react"
import { formatGBP } from "@gg/shared"
import { motion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Seal } from "@/components/ui/seal"
import { sealIn, useMotionVariants } from "@/design/motion"
import type { DoneSale } from "@/features/till/till-store"

export type ReceiptChoice = "print" | "email" | "gift" | "none"

export interface DonePaneProps {
  done: DoneSale
  /** Which choice is on its way, while it is. */
  pending: ReceiptChoice | null
  /** One line under the choices: why a print or an email did not go. */
  problem: string | null
  /** Set once the route has said there is no address on file. */
  askEmail: boolean
  onChoose: (choice: ReceiptChoice, email?: string) => void
  onNewSale: () => void
}

export function DonePane({
  done,
  pending,
  problem,
  askEmail,
  onChoose,
  onNewSale,
}: DonePaneProps) {
  const seal = useMotionVariants(sealIn)
  const [email, setEmail] = React.useState("")
  const busy = pending !== null
  // A sale still in the offline queue has no record yet to print from.
  const waiting = done.queued

  return (
    <section
      aria-label="Sale done"
      data-testid="till-done"
      className="flex min-h-full flex-col items-start px-5 py-8 sm:px-8"
    >
      <motion.div variants={seal} initial="hidden" animate="visible">
        <Seal />
      </motion.div>

      <div className="mt-8 flex flex-col gap-2" aria-live="polite">
        {done.change > 0 ? (
          <>
            <MicroLabel tone="ink">Change</MicroLabel>
            <span
              data-testid="till-change"
              className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
            >
              {formatGBP(done.change)}
            </span>
            <span className="tnum mt-1 font-mono text-[13px] text-muted-foreground-2">
              {done.number}
            </span>
          </>
        ) : (
          <>
            <MicroLabel>Sold</MicroLabel>
            <span
              data-testid="till-sale-number"
              className="tnum font-mono text-[20px] leading-[1.2] text-foreground"
            >
              {done.number}
            </span>
          </>
        )}
        {done.pointsEarned > 0 ? (
          <p data-testid="till-points-earned" className="mt-2 text-[16px] text-foreground">
            Earns {done.pointsEarned.toLocaleString("en-GB")} points
          </p>
        ) : null}
        {waiting ? (
          <p className="mt-2 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
            Waiting to send. Its receipt can be printed or emailed once it has gone.
          </p>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="Receipt"
        className="mt-10 grid w-full max-w-[720px] grid-cols-2 gap-3 min-[1100px]:grid-cols-4"
      >
        <Button
          variant="key"
          size="till"
          loading={pending === "print"}
          disabled={busy || waiting}
          onClick={() => onChoose("print")}
        >
          Print
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "email"}
          disabled={busy || waiting}
          onClick={() => onChoose("email")}
        >
          Email
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "gift"}
          disabled={busy || waiting}
          onClick={() => onChoose("gift")}
        >
          Gift receipt
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "none"}
          disabled={busy}
          onClick={() => onChoose("none")}
        >
          No receipt
        </Button>
      </div>

      {askEmail ? (
        <div className="mt-8 flex w-full max-w-[560px] flex-col gap-4">
          <Field layout="stacked" label="Email the receipt to" htmlFor="till-receipt-email">
            <Input
              id="till-receipt-email"
              type="email"
              autoComplete="off"
              inputMode="email"
              value={email}
              containerClassName="min-h-14"
              placeholder="name@example.co.uk"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && email.trim()) onChoose("email", email)
              }}
            />
          </Field>
          <Button
            variant="text"
            className="min-h-14 self-start"
            disabled={busy || !email.trim()}
            onClick={() => onChoose("email", email)}
          >
            Send receipt
          </Button>
        </div>
      ) : null}

      <FieldError>{problem}</FieldError>

      <Button
        size="till"
        data-testid="till-new-sale"
        className="mt-10 w-full sm:w-auto sm:min-w-64"
        trailingArrow
        disabled={busy}
        onClick={onNewSale}
      >
        New sale
      </Button>
    </section>
  )
}
