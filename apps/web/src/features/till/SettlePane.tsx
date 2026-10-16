/**
 * Finishing a ticket that carries a trade-in or a return, when there is
 * nothing left to take for it (docs/api-contract-epos.md, section 7;
 * DESIGN.md, section 10, "Paying"):
 *
 *  - Settle: a trade that, alone or with a return, covers the sale. The
 *    surplus goes to the customer as store credit, or in cash at the cash
 *    rate (keyed lower if agreed, never above the credit surplus), with the
 *    difference said in words. Cash runs the buy-in's ID step unless the
 *    customer's ID is verified and in date, and the cash cap. Any of a
 *    return the sale did not use goes back too. Every trade takes the terms
 *    and the signature.
 *  - Refund: a return worth the sale or more, with no trade. The
 *    difference goes back as cash, to the original card, or as store
 *    credit.
 *
 * Like the tender pane, these take the catalogue's place while the ticket
 * stays beside them, read only, and each carries the screen's one Anton
 * figure and its one block.
 */
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { SignaturePad } from "@/features/tradein/SignaturePad"
import { TradeTerms } from "@/features/tradein/TradeTerms"
import { IdStep } from "@/features/tradein/steps/IdStep"
import type { IdCaptureValues } from "@/features/tradein/id-capture"
import { cashBlock, type IdGate, type WizardCustomer } from "@/features/tradein/machine"
import { AmountPad } from "@/features/till/AmountPad"
import {
  cashRateSurplus,
  needsIdStep,
  settleSentence,
  surplusCash,
  surplusCashProblem,
  surplusDifference,
  type SurplusChoice,
  type TicketSettlement,
  type TradeFigures,
} from "@/features/till/exchange"
import { REFUND_METHODS, type RefundMethod } from "@/features/till/returns"
import type { TicketReturn } from "@/features/till/ticket"

/** The terms and the signature pad, which every trade takes before it completes. */
export function TradeAgreement({
  terms,
  signature,
  onTerms,
  onSignature,
}: {
  terms: boolean
  signature: string | null
  onTerms: (accepted: boolean) => void
  onSignature: (signature: string | null) => void
}) {
  return (
    <div data-testid="till-trade-agreement" className="flex flex-col gap-8">
      <TradeTerms accepted={terms} onChange={onTerms} />
      <div className="max-w-[40rem]">
        <SignaturePad onChange={onSignature} />
        {signature ? (
          <Hint aria-live="polite" className="mt-3 block">
            Signature captured
          </Hint>
        ) : null}
      </div>
    </div>
  )
}

/** The Trade-in step under the tender keys, when the trade pays part of the sale. */
export function TradeStep({
  applied,
  terms,
  signature,
  onTerms,
  onSignature,
}: {
  applied: number
  terms: boolean
  signature: string | null
  onTerms: (accepted: boolean) => void
  onSignature: (signature: string | null) => void
}) {
  return (
    <div data-testid="till-trade-step" className="flex max-w-[640px] flex-col gap-8">
      <p className="text-[20px] leading-[1.4] text-foreground">
        The trade-in pays <span className="tnum font-medium">{formatGBP(applied)}</span> towards
        this sale.
      </p>
      <TradeAgreement
        terms={terms}
        signature={signature}
        onTerms={onTerms}
        onSignature={onSignature}
      />
    </div>
  )
}

function PaneHeader({
  label,
  amount,
  testId,
  showBack,
  onBack,
}: {
  label: string
  amount: number
  testId: string
  showBack: boolean
  onBack: () => void
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
      <div className="flex flex-col gap-2">
        <MicroLabel tone="ink">{label}</MicroLabel>
        <span
          data-testid={testId}
          aria-live="polite"
          className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
        >
          {formatGBP(amount)}
        </span>
      </div>
      {showBack ? (
        <Button variant="text" className="min-h-14" onClick={onBack}>
          Back to the ticket
        </Button>
      ) : null}
    </div>
  )
}

/** One of the two surplus choices: its key, its figure in Jost, and a line under it. */
function SurplusOption({
  label,
  amount,
  note,
  pressed,
  disabled,
  testId,
  onChoose,
}: {
  label: string
  amount: number
  note: string
  pressed: boolean
  disabled?: boolean
  testId: string
  onChoose: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Button
        variant="key"
        size="till"
        aria-pressed={pressed}
        disabled={disabled}
        data-testid={testId}
        onClick={onChoose}
      >
        {label}
      </Button>
      <span className="tnum text-[20px] leading-none font-medium text-foreground">
        {formatGBP(amount)}
      </span>
      <span className="text-[13px] leading-[1.45] text-muted-foreground">{note}</span>
    </div>
  )
}

export interface SettlePaneProps {
  settlement: TicketSettlement
  figures: TradeFigures
  choice: SurplusChoice | null
  /** The cash keyed for the surplus, as pence digits; "" means the suggested figure. */
  cashDigits: string
  terms: boolean
  signature: string | null
  seller: WizardCustomer | null
  cashCap: number
  gate: IdGate
  capture: IdCaptureValues
  /** The trade-in points a credit surplus earns. */
  creditPoints: number
  /** A return on the same ticket, whose difference goes back too. */
  returns: TicketReturn | null
  refundMethod: RefundMethod | null
  last4: string
  completing: boolean
  error: string | null
  onChoice: (choice: SurplusChoice) => void
  onCashDigits: (digits: string) => void
  onTerms: (accepted: boolean) => void
  onSignature: (signature: string | null) => void
  onCapture: (patch: Partial<IdCaptureValues>) => void
  onMethod: (method: RefundMethod) => void
  onLast4: (last4: string) => void
  onComplete: () => void
  onBack: () => void
}

export function SettlePane({
  settlement,
  figures,
  choice,
  cashDigits,
  terms,
  signature,
  seller,
  cashCap,
  gate,
  capture,
  creditPoints,
  returns,
  refundMethod,
  last4,
  completing,
  error,
  onChoice,
  onCashDigits,
  onTerms,
  onSignature,
  onCapture,
  onMethod,
  onLast4,
  onComplete,
  onBack,
}: SettlePaneProps) {
  const surplus = settlement.surplus
  const suggested = cashRateSurplus(surplus, figures)
  const cash = surplusCash(cashDigits, settlement, figures)
  const standing = seller ? cashBlock(seller.facts, 0, cashCap) : null
  const amountBlock = seller && choice === "cash" ? cashBlock(seller.facts, cash, cashCap) : null
  // Everything the customer walks away with: the surplus as chosen, and
  // any of a return that the sale did not use.
  const paidOut = (choice === "cash" ? cash : surplus) + settlement.refund
  const idStep = needsIdStep(settlement, choice) && seller && amountBlock?.kind === "none"

  return (
    <section
      aria-label="Settle"
      data-testid="till-settle"
      className="flex min-h-full flex-col px-5 py-6 sm:px-8"
    >
      <PaneHeader
        label={paidOut > 0 ? "To the customer" : "To pay"}
        amount={paidOut}
        testId="till-settle-amount"
        showBack={!completing}
        onBack={onBack}
      />
      <p className="mt-5 max-w-[56ch] text-[16px] leading-[1.5] text-foreground">
        {settleSentence(settlement)}
      </p>

      {surplus > 0 ? (
        <div className="mt-10">
          <MicroLabel tone="ink" className="mb-3">
            Pay the surplus as
          </MicroLabel>
          <div
            role="group"
            aria-label="Pay the surplus as"
            className="grid max-w-[560px] grid-cols-2 gap-x-3 gap-y-4"
          >
            <SurplusOption
              label="Store credit"
              amount={surplus}
              note={
                creditPoints > 0
                  ? `Earns ${creditPoints.toLocaleString("en-GB")} points. No ID needed.`
                  : "No ID needed."
              }
              pressed={choice === "credit"}
              testId="till-surplus-credit"
              onChoose={() => onChoice("credit")}
            />
            <SurplusOption
              label="Cash"
              amount={suggested}
              note={
                standing && standing.kind !== "none"
                  ? standing.message
                  : "At the cash rate. Needs photo ID unless it is on file."
              }
              pressed={choice === "cash"}
              disabled={Boolean(standing && standing.kind !== "none")}
              testId="till-surplus-cash"
              onChoose={() => onChoice("cash")}
            />
          </div>
        </div>
      ) : null}

      {surplus > 0 && choice === "cash" ? (
        <div className="mt-10">
          <AmountPad
            label="Cash to pay out"
            value={cashDigits}
            onChange={onCashDigits}
            placeholder={formatGBP(suggested)}
            invalid={cash < 1 || cash > surplus}
            testId="till-surplus-cash-amount"
          >
            <p
              data-testid="till-surplus-difference"
              className="max-w-[48ch] text-[15px] leading-[1.5] text-foreground"
            >
              {surplusCashProblem(cash, surplus) ?? surplusDifference(cash, surplus)}
            </p>
            {amountBlock && amountBlock.kind !== "none" ? (
              <p role="alert" className="max-w-[48ch] text-[15px] leading-[1.5] text-destructive">
                {amountBlock.message}
              </p>
            ) : null}
          </AmountPad>
        </div>
      ) : null}

      {idStep && seller ? (
        <div className="mt-14" data-testid="till-id-step">
          <IdStep
            customer={seller}
            payout={{ type: "cash", cash, credit: 0 }}
            cashCap={cashCap}
            values={capture}
            onChange={onCapture}
            gate={gate}
            serverError={null}
          />
        </div>
      ) : null}

      {returns && settlement.refund > 0 ? (
        <div className="mt-14">
          <RefundChoice
            returns={returns}
            amount={settlement.refund}
            method={refundMethod}
            last4={last4}
            onMethod={onMethod}
            onLast4={onLast4}
          />
        </div>
      ) : null}

      <div className="mt-14">
        <TradeAgreement
          terms={terms}
          signature={signature}
          onTerms={onTerms}
          onSignature={onSignature}
        />
      </div>

      <div className="mt-10 flex max-w-[64ch] flex-col items-start gap-6">
        <FieldError>{error}</FieldError>
        <Button
          size="till"
          data-testid="till-settle-complete"
          className="w-full sm:w-auto sm:min-w-64"
          trailingArrow
          loading={completing}
          onClick={onComplete}
        >
          Complete
        </Button>
      </div>
    </section>
  )
}

/** Where a return's difference goes back: cash, the card it was paid on, or store credit. */
function RefundChoice({
  returns,
  amount,
  method,
  last4,
  onMethod,
  onLast4,
}: {
  returns: TicketReturn
  amount: number
  method: RefundMethod | null
  last4: string
  onMethod: (method: RefundMethod) => void
  onLast4: (last4: string) => void
}) {
  return (
    <div data-testid="till-refund-choice" className="flex max-w-[560px] flex-col gap-6">
      <div>
        <MicroLabel tone="ink" className="mb-3">
          {`${formatGBP(amount)} back to`}
        </MicroLabel>
        <div role="group" aria-label="Refund to" className="grid grid-cols-3 gap-3">
          {REFUND_METHODS.map(({ method: key, label }) => (
            <Button
              key={key}
              variant="key"
              size="till"
              aria-pressed={method === key}
              disabled={key === "store_credit" && !returns.customer}
              onClick={() => onMethod(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        {!returns.customer ? (
          <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground">
            Store credit needs the customer on the sale.
          </p>
        ) : null}
      </div>
      {method === "card_tide" ? (
        <div className="flex flex-col gap-3">
          <p className="text-[15px] leading-[1.5] text-foreground">
            Refund <span className="tnum font-medium">{formatGBP(amount)}</span> on the Tide reader,
            then record it here.
          </p>
          <Field layout="stacked" label="Card's last four digits" htmlFor="till-refund-last4">
            <Input
              id="till-refund-last4"
              value={last4}
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              containerClassName="min-h-14 max-w-[220px]"
              className="tnum font-mono text-[20px] tracking-[0.12em]"
              onChange={(event) => onLast4(event.target.value.replace(/\D/g, "").slice(0, 4))}
            />
          </Field>
        </div>
      ) : null}
    </div>
  )
}

export interface RefundPaneProps {
  settlement: TicketSettlement
  returns: TicketReturn
  saleLines: number
  method: RefundMethod | null
  last4: string
  completing: boolean
  error: string | null
  onMethod: (method: RefundMethod) => void
  onLast4: (last4: string) => void
  onComplete: () => void
  onBack: () => void
}

export function RefundPane({
  settlement,
  returns,
  saleLines,
  method,
  last4,
  completing,
  error,
  onMethod,
  onLast4,
  onComplete,
  onBack,
}: RefundPaneProps) {
  const rest = settlement.refund
  return (
    <section
      aria-label="Refund"
      data-testid="till-refund"
      className="flex min-h-full flex-col px-5 py-6 sm:px-8"
    >
      <PaneHeader
        label={rest > 0 ? "To refund" : "To pay"}
        amount={rest}
        testId="till-refund-amount"
        showBack={!completing}
        onBack={onBack}
      />
      <p className="mt-5 max-w-[56ch] text-[16px] leading-[1.5] text-foreground">
        {saleLines === 0
          ? `Coming back from ${returns.saleNumber}: ${formatGBP(settlement.returns ?? 0)}.`
          : rest > 0
            ? `The return pays the whole ${formatGBP(settlement.sale)} ticket. The rest goes back to the customer.`
            : `The return pays the whole ${formatGBP(settlement.sale)} ticket, exactly.`}
      </p>

      {rest > 0 ? (
        <div className="mt-10">
          <RefundChoice
            returns={returns}
            amount={rest}
            method={method}
            last4={last4}
            onMethod={onMethod}
            onLast4={onLast4}
          />
        </div>
      ) : null}

      <div className="mt-10 flex max-w-[64ch] flex-col items-start gap-6">
        <FieldError>{error}</FieldError>
        <Button
          size="till"
          data-testid="till-refund-complete"
          className="w-full sm:w-auto sm:min-w-64"
          trailingArrow
          loading={completing}
          onClick={onComplete}
        >
          {rest > 0 ? `Refund ${formatGBP(rest)}` : "Complete exchange"}
        </Button>
      </div>
    </section>
  )
}
