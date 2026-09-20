import { cn } from "cn"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Switch } from "@/components/ui/switch"
import { PRIVACY_SENTENCE } from "@/features/customers/format"
import { MoneyField } from "@/features/tradein/MoneyField"
import { SignaturePad } from "@/features/tradein/SignaturePad"
import {
  cashBlock,
  type Payout,
  type Totals,
  type WizardCustomer,
} from "@/features/tradein/machine"
import type { PayoutType } from "@/lib/api"

/** One of the two big choices. Hairline only, never a fill. */
function PayoutTile({
  label,
  amount,
  note,
  selected,
  disabled,
  onSelect,
  testId,
}: {
  label: string
  amount: number
  note?: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-h-32 flex-1 flex-col justify-between gap-6 border p-6 text-left outline-none",
        "transition-colors duration-150 ease-gg",
        selected ? "border-2 border-foreground p-[1.4rem]" : "border-hairline",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:border-foreground"
      )}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase">
          {label}
        </span>
        {selected ? (
          <span className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-foreground uppercase">
            Chosen
          </span>
        ) : null}
      </span>
      <span className="tnum block font-display text-[28px] leading-none tracking-[0.01em] text-foreground">
        {formatGBP(amount)}
      </span>
      {note ? (
        <span className="block text-[13px] leading-[1.45] text-muted-foreground">
          {note}
        </span>
      ) : null}
    </button>
  )
}

export interface OfferStepProps {
  customer: WizardCustomer
  sums: Totals
  payout: Payout
  payoutType: PayoutType
  mixedCash: number
  cashCap: number
  termsAccepted: boolean
  signature: string | null
  onPayoutType: (type: PayoutType) => void
  onMixedCash: (pence: number) => void
  onTerms: (accepted: boolean) => void
  onSignature: (signature: string | null) => void
  blockReason: string | null
  /** Points the credit option would earn, from the live programme. */
  creditPoints: number
}

/**
 * Cash or store credit, and the customer's name on it.
 *
 * The two tiles carry the only figures that matter, in the one place on this
 * screen that uses the display face. Credit is shown with the points it
 * earns, because that is the reason a customer takes it. A customer the shop
 * cannot pay in cash sees the cash tile greyed with the reason underneath
 * rather than the option quietly missing.
 */
export function OfferStep({
  customer,
  sums,
  payout,
  payoutType,
  mixedCash,
  cashCap,
  termsAccepted,
  signature,
  onPayoutType,
  onMixedCash,
  onTerms,
  onSignature,
  blockReason,
  creditPoints,
}: OfferStepProps) {
  const standingBlock = cashBlock(customer.facts, 0, cashCap)
  const cashUnavailable = standingBlock.kind !== "none"

  return (
    <div>
      <SectionHeading className="mt-0">The offer</SectionHeading>

      <div className="flex flex-col gap-5 sm:flex-row">
        <PayoutTile
          testId="tile-cash"
          label="Cash"
          amount={sums.cash}
          selected={payoutType === "cash"}
          disabled={cashUnavailable}
          note={
            cashUnavailable
              ? standingBlock.message
              : "Needs photo ID before it can be paid."
          }
          onSelect={() => onPayoutType("cash")}
        />
        <PayoutTile
          testId="tile-credit"
          label="Store credit"
          amount={sums.credit}
          selected={payoutType === "credit"}
          note={`Earns ${creditPoints.toLocaleString("en-GB")} GG Points, and no ID is needed.`}
          onSelect={() => onPayoutType("credit")}
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-8">
        <Button
          variant="text"
          type="button"
          aria-pressed={payoutType === "mixed"}
          disabled={cashUnavailable}
          onClick={() => onPayoutType(payoutType === "mixed" ? "credit" : "mixed")}
        >
          {payoutType === "mixed" ? "Not mixed" : "Mixed"}
        </Button>
        <Hint>
          {payoutType === "mixed"
            ? "Back to one payout"
            : "Some cash, the rest as store credit"}
        </Hint>
      </div>

      {payoutType === "mixed" ? (
        <div className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-6">
          <div className="w-40">
            <MicroLabel className="mb-2">Cash</MicroLabel>
            <MoneyField
              id="mixed-cash"
              label="Cash part of the payout"
              value={mixedCash}
              onChange={onMixedCash}
            />
          </div>
          <div className="w-40">
            <MicroLabel className="mb-2">Store credit</MicroLabel>
            <p className="tnum pt-1 pb-3.5 font-mono text-[20px] leading-none text-foreground">
              {formatGBP(payout.credit)}
            </p>
          </div>
          <Hint className="pb-3">Mixed pays at the cash rate throughout.</Hint>
        </div>
      ) : null}

      {/* ---- Terms and signature ---------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">Terms</SectionHeading>
        <div className="flex items-start gap-4">
          <Switch
            checked={termsAccepted}
            onCheckedChange={onTerms}
            aria-label="The customer has heard the terms and agrees to them"
          />
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
            The customer confirms the items are theirs to sell and agrees to the
            buy-in terms. {PRIVACY_SENTENCE}
          </p>
        </div>

        <div className="mt-10 max-w-[40rem]">
          <SignaturePad onChange={onSignature} />
          {signature ? (
            <Hint aria-live="polite" className="mt-3 block">
              Signature captured
            </Hint>
          ) : null}
        </div>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-8">
        <Button
          variant="text"
          type="button"
          onClick={() =>
            window.open("/display", "gg-display", "width=1280,height=800")
          }
        >
          Show customer
        </Button>
        <Hint>Opens the counter display</Hint>
      </div>

      {blockReason ? (
        <p role="alert" className="mt-8 max-w-[56ch] text-[13px] text-destructive">
          {blockReason}
        </p>
      ) : null}
    </div>
  )
}
