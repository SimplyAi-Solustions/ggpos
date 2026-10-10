/**
 * Money in and out of the drawer without a sale (docs/api-contract-epos.md,
 * section 3): paid in or out, a bank drop, and a no sale. Each is a sheet,
 * because each is a short secondary task on the cash-up screen, and each
 * says what the money was for before it goes, because the X and the Z list
 * every one of them.
 *
 * The capability each needs (`paid_in_out`, `no_sale`) is the server's to
 * check; the call goes through `withOverride`, so a member of staff gets a
 * manager's approval on the spot and the same call goes again.
 */
import * as React from "react"
import { formatGBP, parseDecimalToMinor } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { MoneyInput } from "@/features/sell/money-input"
import { OverrideCancelled, withOverride } from "@/features/lock/override"
import { refusalOrFallback } from "@/lib/api/refusal"
import { recordMovement, recordNoSale, type QueuedJob } from "@/lib/api/tillops"

export type DrawerTask = "paid_in_out" | "bank_drop" | "no_sale"

/** What happened, for the screen to say once the sheet has closed. */
export interface DrawerDone {
  said: string
  /** Null when the server already queued the drawer. */
  printJob: QueuedJob
}

const AMOUNT_HELP = "Enter the amount in pounds and pence, for example 5.00."

function MoneyForm({
  task,
  onDone,
  onCancel,
}: {
  task: "paid_in_out" | "bank_drop"
  onDone: (done: DrawerDone) => void
  onCancel: () => void
}) {
  const [direction, setDirection] = React.useState<"paid_out" | "paid_in">("paid_out")
  const [amount, setAmount] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [problem, setProblem] = React.useState<{
    field: "amount" | "reason" | "form"
    message: string
  } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const drop = task === "bank_drop"
  const type = drop ? "bank_drop" : direction

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const pence = parseDecimalToMinor(amount)
    if (pence === null || pence <= 0) {
      setProblem({ field: "amount", message: AMOUNT_HELP })
      return
    }
    if (!reason.trim()) {
      setProblem({ field: "reason", message: "Say what the money was for." })
      return
    }
    setProblem(null)
    setBusy(true)
    const what =
      type === "bank_drop"
        ? `Bank drop of ${formatGBP(pence)}`
        : type === "paid_in"
          ? `Pay in ${formatGBP(pence)}`
          : `Pay out ${formatGBP(pence)}`
    try {
      const result = await withOverride(
        (headers) => recordMovement({ type, amount: pence, reason: reason.trim() }, headers),
        { describe: () => what, context: { amount: pence, reason: reason.trim() } }
      )
      onDone({
        said:
          type === "bank_drop"
            ? `Bank drop of ${formatGBP(pence)} recorded.`
            : type === "paid_in"
              ? `Paid in ${formatGBP(pence)}: ${reason.trim()}.`
              : `Paid out ${formatGBP(pence)}: ${reason.trim()}.`,
        printJob: result.print_job,
      })
    } catch (cause) {
      if (cause instanceof OverrideCancelled) return
      setProblem({
        field: "form",
        message: refusalOrFallback(cause, "That did not record. Try again."),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label={drop ? "Bank drop" : "Paid in or out"}>
      <SheetBody>
        <FieldRow>
          {drop ? null : (
            <Field layout="stacked" label="Which way">
              <ChipGroup
                aria-label="Paid in or paid out"
                value={[direction]}
                onValueChange={(next: string[]) => {
                  const chosen = next[0]
                  if (chosen === "paid_in" || chosen === "paid_out") setDirection(chosen)
                }}
              >
                <Chip value="paid_out">Paid out</Chip>
                <Chip value="paid_in">Paid in</Chip>
              </ChipGroup>
            </Field>
          )}
          <Field
            layout="stacked"
            label="Amount"
            htmlFor="drawer-amount"
            error={problem?.field === "amount" ? problem.message : null}
          >
            <MoneyInput
              id="drawer-amount"
              autoFocus
              value={amount}
              invalid={problem?.field === "amount"}
              onChange={(next) => {
                setAmount(next)
                if (problem?.field === "amount") setProblem(null)
              }}
            />
          </Field>
          <Field
            layout="stacked"
            label={drop ? "Bag or note" : "What for"}
            htmlFor="drawer-reason"
            error={problem?.field === "reason" ? problem.message : null}
          >
            <Input
              id="drawer-reason"
              maxLength={200}
              autoComplete="off"
              placeholder={drop ? "Bag 14, banked by Mo" : "Milk for the shop"}
              value={reason}
              aria-invalid={problem?.field === "reason" ? true : undefined}
              onChange={(event) => {
                setReason(event.target.value)
                if (problem?.field === "reason") setProblem(null)
              }}
            />
          </Field>
        </FieldRow>
        {problem?.field === "form" ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {problem.message}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          {drop ? "Record bank drop" : direction === "paid_in" ? "Record paid in" : "Record paid out"}
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

function NoSaleForm({
  onDone,
  onCancel,
}: {
  onDone: (done: DrawerDone) => void
  onCancel: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [problem, setProblem] = React.useState<string | null>(null)
  const [refused, setRefused] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!reason.trim()) {
      setProblem("Say why the drawer is being opened.")
      return
    }
    setProblem(null)
    setRefused(null)
    setBusy(true)
    try {
      const result = await withOverride((headers) => recordNoSale(reason.trim(), headers), {
        describe: () => "Open the drawer with no sale",
        context: { reason: reason.trim() },
      })
      onDone({ said: `No sale recorded: ${reason.trim()}.`, printJob: result.print_job })
    } catch (cause) {
      if (cause instanceof OverrideCancelled) return
      setRefused(refusalOrFallback(cause, "The drawer did not open. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="No sale">
      <SheetBody>
        <Field layout="stacked" label="Why" htmlFor="no-sale-reason" error={problem}>
          <Input
            id="no-sale-reason"
            autoFocus
            maxLength={200}
            autoComplete="off"
            placeholder="Change for the float"
            value={reason}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setReason(event.target.value)
              setProblem(null)
            }}
          />
        </Field>
        {refused ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {refused}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Open the drawer
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

const COPY: Record<DrawerTask, { title: string; description: string }> = {
  paid_in_out: {
    title: "Paid in or out",
    description: "Petty cash in or out of the drawer, with what it was for. It is on the X and the Z.",
  },
  bank_drop: {
    title: "Bank drop",
    description: "Cash taken out of the drawer for the bank. It cannot be more than the drawer should hold.",
  },
  no_sale: {
    title: "No sale",
    description: "Opens the drawer with nothing sold. Every no sale is on the X and the Z, with its reason.",
  },
}

export function DrawerSheet({
  task,
  onOpenChange,
  onDone,
}: {
  task: DrawerTask | null
  onOpenChange: (open: boolean) => void
  onDone: (done: DrawerDone) => void
}) {
  const copy = task ? COPY[task] : null
  return (
    <Sheet open={task !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
        {task && copy ? (
          <>
            <SheetHeader>
              <SheetTitle>{copy.title}</SheetTitle>
              <SheetDescription>{copy.description}</SheetDescription>
            </SheetHeader>
            {task === "no_sale" ? (
              <NoSaleForm onDone={onDone} onCancel={() => onOpenChange(false)} />
            ) : (
              <MoneyForm
                key={task}
                task={task}
                onDone={onDone}
                onCancel={() => onOpenChange(false)}
              />
            )}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
