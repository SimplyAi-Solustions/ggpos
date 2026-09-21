/**
 * "Take card payment": the sheet the counter watches while the customer
 * taps their card on the Solo.
 *
 * One amount, one sentence about where it has got to, and one way out of
 * each ending. Two of those endings are load-bearing:
 *
 * - While the amount is live on the reader there is no way out but Cancel,
 *   which stops it at the reader. No corner cross, and Esc and the backdrop
 *   are refused by the reducer, because a sheet dismissed by accident would
 *   leave a customer paying with nothing watching.
 * - When the customer has paid and the sale would not complete, the sheet
 *   says so, shows something to find the payment by and names the two ways
 *   out, rather than leaving anybody guessing about money that has moved.
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
  isCardPaymentLocked,
  isCardPaymentOpen,
  paymentReference,
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
  const locked = isCardPaymentLocked(state)
  const taken = state.phase === "taken" ? state : null
  const stopped = state.phase === "stopped" ? state : null
  const reference = taken ? paymentReference(taken.checkout) : null

  return (
    <Sheet
      open={open}
      onOpenChange={(next: boolean) => {
        // A live payment has one way out, and it is the Cancel button.
        if (!next && !locked) onClose()
      }}
    >
      <SheetContent
        side="bottom"
        data-testid="card-payment-sheet"
        showCloseButton={!locked}
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>Card payment</SheetTitle>
          <SheetDescription>
            {state.phase === "waiting" && state.checkout.reader_name
              ? state.checkout.reader_name
              : readerName}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <span
            data-testid="card-payment-amount"
            className="tnum block font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(checkoutAmount(state))}
          </span>

          {locked ? (
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
              <span className="flex flex-col gap-1">
                <Hint>{reference ? reference.label : "No reference"}</Hint>
                <span
                  data-testid="card-payment-code"
                  className="tnum font-mono text-[15px] text-foreground"
                >
                  {reference
                    ? reference.value
                    : `${formatGBP(taken.checkout.amount)} on ${
                        taken.checkout.reader_name || readerName
                      }`}
                </span>
              </span>
              <p className="max-w-[44ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                {reference
                  ? "Refund it in the SumUp app, or put the basket right and mark the sale sold: it will use this payment rather than asking for another."
                  : "SumUp gave no reference for it, so find it in the SumUp app by the amount and the time. Or put the basket right and mark the sale sold, which will use this payment rather than asking for another."}
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
              {/* A reader busy with somebody else's payment is not something
                  pressing the button again can get past. */}
              {stopped.retry ? (
                <Button trailingArrow onClick={onRetry}>
                  Try again
                </Button>
              ) : null}
              <Button
                variant={stopped.retry ? "text" : "block"}
                trailingArrow={!stopped.retry}
                data-testid="card-payment-close"
                onClick={onClose}
              >
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
