/**
 * "Take card payment": the sheet the counter watches while the customer
 * taps their card on the Solo.
 *
 * One amount, one sentence about where it has got to, and one way out of
 * each ending. The only complicated state is the last one: the customer has
 * paid and the sale would not complete, which says what happened, shows the
 * transaction code and names the two ways out rather than leaving anybody
 * guessing about money that has already moved.
 */
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { RingSpinner } from "@/components/ui/icons"
import { Hint } from "@/components/ui/micro-label"
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
  checkoutAmount,
  isCardPaymentOpen,
  type CardPaymentState,
} from "@/features/sell/checkout"

export interface CardPaymentSheetProps {
  state: CardPaymentState
  /** Which reader the amount went to, for the line under the title. */
  readerName: string
  cancelling: boolean
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}

/** What the sheet says about where the payment has got to. */
function statusLine(state: CardPaymentState): string {
  switch (state.phase) {
    case "opening":
      return "Sending the amount to the reader."
    case "waiting":
      return "Waiting for the reader."
    case "completing":
      return "Paid. Finishing the sale."
    default:
      return ""
  }
}

export function CardPaymentSheet({
  state,
  readerName,
  cancelling,
  onCancel,
  onRetry,
  onClose,
}: CardPaymentSheetProps) {
  const open = isCardPaymentOpen(state)
  const working =
    state.phase === "opening" || state.phase === "waiting" || state.phase === "completing"
  const taken = state.phase === "taken" ? state : null
  const stopped = state.phase === "stopped" ? state : null

  return (
    <Sheet
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose()
      }}
    >
      <SheetContent
        side="bottom"
        data-testid="card-payment-sheet"
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>Card payment</SheetTitle>
          <SheetDescription>{readerName}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <span
            data-testid="card-payment-amount"
            className="tnum block font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(checkoutAmount(state))}
          </span>

          {working ? (
            <p
              data-testid="card-payment-status"
              aria-live="polite"
              className="mt-6 flex items-center gap-3 text-[15px] text-muted-foreground"
            >
              <RingSpinner className="text-foreground" />
              {statusLine(state)}
            </p>
          ) : null}

          {stopped ? (
            <p
              data-testid="card-payment-status"
              role="alert"
              className="mt-6 max-w-[44ch] text-[15px] leading-[1.5] text-foreground"
            >
              {stopped.reason}
            </p>
          ) : null}

          {taken ? (
            <div className="mt-6 flex flex-col gap-3">
              <p
                data-testid="card-payment-status"
                role="alert"
                className="max-w-[44ch] text-[15px] leading-[1.5] text-foreground"
              >
                The customer has paid, and the sale did not go through.{" "}
                {taken.reason}
              </p>
              {taken.checkout.transaction_code ? (
                <span className="flex flex-col gap-1">
                  <Hint>SumUp transaction</Hint>
                  <span
                    data-testid="card-payment-code"
                    className="tnum font-mono text-[15px] text-foreground"
                  >
                    {taken.checkout.transaction_code}
                  </span>
                </span>
              ) : null}
              <p className="max-w-[44ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                Refund it in the SumUp app, or put the basket right and mark
                the sale sold: it will use this payment rather than asking for
                another.
              </p>
            </div>
          ) : null}
        </SheetBody>

        <SheetFooter>
          {state.phase === "waiting" ? (
            <Button
              variant="text"
              loading={cancelling}
              disabled={cancelling}
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : null}

          {stopped ? (
            <>
              <Button trailingArrow onClick={onRetry}>
                Try again
              </Button>
              <Button variant="text" onClick={onClose}>
                Close
              </Button>
            </>
          ) : null}

          {taken ? (
            <Button trailingArrow onClick={onClose}>
              Back to the sale
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
