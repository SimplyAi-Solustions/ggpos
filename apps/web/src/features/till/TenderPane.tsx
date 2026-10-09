/**
 * Paying (DESIGN.md, section 10, "Paying"): the catalogue pane becomes the
 * tender pane. What is left to pay is the screen's one Anton line; the
 * tenders are a row of 72px keys, each opening its step under the row; the
 * tenders taken are hairline rows, removable until the sale completes. When
 * nothing is left, the sale completes on its own (the screen above does
 * that, once per set of tenders).
 *
 * The card step says the amount and nothing about talking to the reader,
 * because the till does not: Tide takes the card on its own, staff key the
 * amount there and say here whether it was approved.
 */
import * as React from "react"
import {
  formatGBP,
  penceToPoints,
  pointsToPence,
  type LoyaltyProgramme,
} from "@gg/shared"
import { XIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { AmountPad } from "@/features/till/AmountPad"
import { digitsToPence, penceToDigits } from "@/features/till/icons"
import type { EposSettings } from "@/features/till/epos-settings"
import type { TenderStep } from "@/features/till/till-store"
import {
  maxPoints,
  maxStoreCredit,
  quickNotes,
  takeCard,
  takeCash,
  takePoints,
  takeStoreCredit,
  tenderLabel,
  type TakenTender,
  type TenderState,
} from "@/features/till/tenders"
import type { RewardVoucher, SaleCustomer } from "@/lib/api/types"

const STEPS: { step: TenderStep; label: string }[] = [
  { step: "cash", label: "Cash" },
  { step: "card_tide", label: "Card" },
  { step: "store_credit", label: "Store credit" },
  { step: "points", label: "Points" },
  { step: "voucher", label: "Voucher" },
]

export interface TenderPaneProps {
  total: number
  taken: TakenTender[]
  state: TenderState
  step: TenderStep | null
  customer: SaleCustomer | null
  voucher: RewardVoucher | null
  settings: EposSettings
  programme?: LoyaltyProgramme
  cashCap?: number
  completing: boolean
  /** Why the sale did not go through, when it did not. */
  error: string | null
  onStep: (step: TenderStep | null) => void
  onTenders: (next: TakenTender[]) => void
  onRemoveTender: (id: string) => void
  /** Resolves to the refusal to show, or null once applied. */
  onApplyVoucher: (code: string) => Promise<string | null>
  onRemoveVoucher: () => void
  onAddCustomer: () => void
  onBack: () => void
  onRetry: () => void
}

function StepBlock({
  children,
  onClick,
  testId,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  testId: string
  disabled?: boolean
}) {
  return (
    <Button
      size="till"
      data-testid={testId}
      className="w-full sm:w-auto sm:min-w-64"
      trailingArrow
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function CashStep({
  total,
  taken,
  left,
  quick,
  cashCap,
  onTenders,
}: {
  total: number
  taken: TakenTender[]
  left: number
  quick: number[]
  cashCap?: number
  onTenders: (next: TakenTender[]) => void
}) {
  const [digits, setDigits] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  function take(handed: number) {
    const result = takeCash(taken, total, handed, cashCap)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(null)
    setDigits("")
    onTenders(result.value)
  }

  return (
    <div data-testid="till-cash-step">
      <AmountPad
        label="Cash handed over"
        value={digits}
        onChange={(next) => {
          setDigits(next)
          setError(null)
        }}
        onEnter={() => take(digitsToPence(digits) || left)}
        invalid={Boolean(error)}
        placeholder={formatGBP(left)}
        testId="till-cash-amount"
        actions={
          <>
            <FieldError>{error}</FieldError>
            <StepBlock testId="till-take-cash" onClick={() => take(digitsToPence(digits) || left)}>
              Take cash
            </StepBlock>
          </>
        }
      >
        <div role="group" aria-label="Quick cash" className="flex flex-wrap gap-3">
          <Button variant="key" size="till" className="min-w-28" onClick={() => take(left)}>
            Exact
          </Button>
          {quickNotes(left, quick).map((note) => (
            <Button
              key={note}
              variant="key"
              size="till"
              className="tnum min-w-24"
              aria-label={`${formatGBP(note)} handed over`}
              onClick={() => take(note)}
            >
              {formatGBP(note).replace(/\.00$/, "")}
            </Button>
          ))}
        </div>
      </AmountPad>
    </div>
  )
}

function CardStep({
  left,
  taken,
  requireLast4,
  onTenders,
  onDeclined,
}: {
  left: number
  taken: TakenTender[]
  requireLast4: boolean
  onTenders: (next: TakenTender[]) => void
  onDeclined: () => void
}) {
  const [last4, setLast4] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  function approve() {
    const result = takeCard(taken, left, last4, requireLast4)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onTenders(result.value)
  }

  return (
    <div data-testid="till-card-step" className="flex max-w-[560px] flex-col gap-8">
      <p className="text-[20px] leading-[1.4] text-foreground">
        Key <span className="tnum font-medium">{formatGBP(left)}</span> on the Tide reader.
      </p>
      <Field
        layout="stacked"
        label={requireLast4 ? "Last four digits" : "Last four digits, if you have them"}
        htmlFor="till-card-last4"
      >
        <Input
          id="till-card-last4"
          value={last4}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          pattern="[0-9]*"
          aria-invalid={error ? true : undefined}
          containerClassName="min-h-16 max-w-[220px]"
          className="tnum font-mono text-[28px] leading-[1.2] tracking-[0.12em]"
          placeholder="0000"
          onChange={(event) => {
            setLast4(event.target.value.replace(/\D/g, "").slice(0, 4))
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") approve()
          }}
        />
      </Field>
      <FieldError>{error}</FieldError>
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
        <StepBlock testId="till-card-approved" onClick={approve}>
          Approved
        </StepBlock>
        <Button variant="text" className="min-h-14" onClick={onDeclined}>
          Declined
        </Button>
      </div>
    </div>
  )
}

function BalanceStep({
  kind,
  balanceLine,
  most,
  onTake,
  testId,
}: {
  kind: "store_credit" | "points"
  balanceLine: string
  most: number
  onTake: (amount: number) => string | null
  testId: string
}) {
  const [digits, setDigits] = React.useState(() => penceToDigits(most))
  const [error, setError] = React.useState<string | null>(null)
  const take = () => {
    const problem = onTake(digitsToPence(digits))
    setError(problem)
  }
  return (
    <div data-testid={testId}>
      <AmountPad
        label={kind === "store_credit" ? "Store credit to use" : "Paid in points"}
        value={digits}
        onChange={(next) => {
          setDigits(next)
          setError(null)
        }}
        onEnter={take}
        invalid={Boolean(error)}
        actions={
          <>
            <FieldError>{error}</FieldError>
            <StepBlock
              testId={kind === "store_credit" ? "till-take-credit" : "till-take-points"}
              disabled={most <= 0}
              onClick={take}
            >
              {kind === "store_credit" ? "Take store credit" : "Take points"}
            </StepBlock>
          </>
        }
      >
        <dl className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-6 border-b border-hairline-soft pb-2">
            <dt>
              <MicroLabel>Balance</MicroLabel>
            </dt>
            <dd className="tnum text-[15px] text-foreground">{balanceLine}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-6 border-b border-hairline-soft pb-2">
            <dt>
              <MicroLabel>Most on this ticket</MicroLabel>
            </dt>
            <dd className="tnum text-[15px] text-foreground">{formatGBP(most)}</dd>
          </div>
        </dl>
      </AmountPad>
    </div>
  )
}

function VoucherStep({
  voucher,
  onApply,
  onRemove,
}: {
  voucher: RewardVoucher | null
  onApply: (code: string) => Promise<string | null>
  onRemove: () => void
}) {
  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  if (voucher) {
    return (
      <div className="flex max-w-[560px] flex-col gap-4">
        <p className="text-[16px] leading-[1.5] text-foreground">
          {voucher.rewardName} is on this ticket.
        </p>
        <Button variant="text" className="min-h-14 self-start" onClick={onRemove}>
          Take the voucher off
        </Button>
      </div>
    )
  }

  async function apply() {
    if (!code.trim()) {
      setError("Scan the voucher or type its code.")
      return
    }
    setPending(true)
    const problem = await onApply(code.trim())
    setPending(false)
    setError(problem)
    if (!problem) setCode("")
  }

  return (
    <div data-testid="till-voucher-step" className="flex max-w-[560px] flex-col gap-6">
      <Field layout="stacked" label="Voucher code" htmlFor="till-voucher-code">
        <Input
          id="till-voucher-code"
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder="GGV-"
          aria-invalid={error ? true : undefined}
          containerClassName="min-h-14"
          className="font-mono uppercase"
          onChange={(event) => {
            setCode(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void apply()
          }}
        />
      </Field>
      <FieldError>{error}</FieldError>
      <StepBlock testId="till-apply-voucher" disabled={pending} onClick={() => void apply()}>
        Apply voucher
      </StepBlock>
    </div>
  )
}

export function TenderPane({
  total,
  taken,
  state,
  step,
  customer,
  voucher,
  settings,
  programme,
  cashCap,
  completing,
  error,
  onStep,
  onTenders,
  onRemoveTender,
  onApplyVoucher,
  onRemoveVoucher,
  onAddCustomer,
  onBack,
  onRetry,
}: TenderPaneProps) {
  const [declined, setDeclined] = React.useState(false)
  const left = state.left
  const settled = left === 0 && state.over === 0

  const needsCustomer = (
    <div className="flex max-w-[560px] flex-col items-start gap-4">
      <p className="text-[16px] leading-[1.5] text-foreground">
        {step === "points"
          ? "Attach the customer to pay with points."
          : "Attach the customer to pay with store credit."}
      </p>
      <Button variant="text" className="min-h-14" onClick={onAddCustomer}>
        Add customer
      </Button>
    </div>
  )

  return (
    <section aria-label="Payment" className="flex min-h-full flex-col px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex flex-col gap-2">
          <MicroLabel tone="ink">To pay</MicroLabel>
          <span
            data-testid="till-to-pay"
            aria-live="polite"
            className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
          >
            {formatGBP(left)}
          </span>
        </div>
        <Button
          variant="text"
          className="min-h-14"
          disabled={completing}
          onClick={onBack}
        >
          Back to the ticket
        </Button>
      </div>

      <div
        role="group"
        aria-label="Take payment by"
        className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 min-[90rem]:grid-cols-5"
      >
        {STEPS.map(({ step: key, label }) => (
          <Button
            key={key}
            variant="key"
            size="till"
            aria-pressed={step === key}
            disabled={completing || (settled && key !== "voucher")}
            onClick={() => {
              setDeclined(false)
              onStep(step === key ? null : key)
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="mt-8">
        {completing ? (
          <p role="status" className="text-[16px] text-muted-foreground">
            Completing the sale.
          </p>
        ) : step === "cash" && !settled ? (
          <CashStep
            total={total}
            taken={taken}
            left={left}
            quick={settings.quickCash}
            cashCap={cashCap}
            onTenders={onTenders}
          />
        ) : step === "card_tide" && !settled ? (
          <CardStep
            left={left}
            taken={taken}
            requireLast4={settings.requireCardLast4}
            onTenders={onTenders}
            onDeclined={() => {
              setDeclined(true)
              onStep(null)
            }}
          />
        ) : step === "store_credit" && !settled ? (
          customer ? (
            <BalanceStep
              key={`credit-${left}`}
              kind="store_credit"
              testId="till-credit-step"
              balanceLine={formatGBP(customer.creditBalance)}
              most={maxStoreCredit(taken, left, customer)}
              onTake={(amount) => {
                const result = takeStoreCredit(taken, left, amount, customer)
                if (!result.ok) return result.message
                onTenders(result.value)
                return null
              }}
            />
          ) : (
            needsCustomer
          )
        ) : step === "points" && !settled ? (
          customer && programme ? (
            <BalanceStep
              key={`points-${left}`}
              kind="points"
              testId="till-points-step"
              balanceLine={`${customer.pointsBalance.toLocaleString("en-GB")} points, ${formatGBP(
                pointsToPence(customer.pointsBalance, programme)
              )}`}
              most={maxPoints(taken, left, total, customer, programme)}
              onTake={(amount) => {
                const result = takePoints(taken, left, total, amount, customer, programme)
                if (!result.ok) return result.message
                onTenders(result.value)
                return null
              }}
            />
          ) : (
            needsCustomer
          )
        ) : step === "voucher" ? (
          <VoucherStep voucher={voucher} onApply={onApplyVoucher} onRemove={onRemoveVoucher} />
        ) : declined ? (
          <p role="status" className="text-[16px] leading-[1.5] text-foreground">
            Declined on the reader. Try the card again, or take it another way.
          </p>
        ) : state.tenders.length === 0 ? (
          <p className="text-[16px] text-muted-foreground">Choose how they are paying.</p>
        ) : null}
      </div>

      {state.tenders.length > 0 ? (
        <div className="mt-10">
          <MicroLabel tone="ink" className="mb-2">
            Taken
          </MicroLabel>
          <ul data-testid="till-tenders">
            {state.tenders.map((tender) => (
              <li
                key={tender.id}
                data-testid="till-tender"
                className="flex min-h-14 items-center gap-4 border-b border-hairline-soft first:border-t"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[16px] text-foreground">{tenderLabel(tender)}</span>
                  {tender.method === "cash" && tender.tendered > tender.amount ? (
                    <span className="tnum text-[13px] text-muted-foreground">
                      {formatGBP(tender.tendered)} handed over, {formatGBP(tender.change)} change
                    </span>
                  ) : tender.method === "points" && programme ? (
                    <span className="tnum text-[13px] text-muted-foreground">
                      {penceToPoints(tender.amount, programme).toLocaleString("en-GB")} points
                    </span>
                  ) : null}
                </span>
                <span className="tnum text-[16px] font-medium text-foreground">
                  {formatGBP(tender.amount)}
                </span>
                <Button
                  variant="ghost-icon"
                  className={cn("size-14", completing && "invisible")}
                  aria-label={`Remove ${tenderLabel(tender)} ${formatGBP(tender.amount)}`}
                  disabled={completing}
                  onClick={() => onRemoveTender(tender.id)}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.over > 0 ? (
        <p role="alert" className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
          The payments come to {formatGBP(state.covered)} but the total is {formatGBP(total)}.
          Remove a payment.
        </p>
      ) : null}

      {error ? (
        <div className="mt-6 flex max-w-[64ch] flex-col items-start gap-4">
          <p role="alert" data-testid="till-sale-error" className="text-[15px] leading-[1.5] text-destructive">
            {error}
          </p>
          {settled ? (
            <Button variant="text" className="min-h-14" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
