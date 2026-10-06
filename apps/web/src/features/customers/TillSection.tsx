/**
 * Two Phase 8 facts on a customer's Guild block: a paid plan they asked for
 * online and have not paid for yet, and whether the Epos Now till knows them.
 *
 * A pending plan starts by itself when the till sells the Guild product to
 * this customer. When that cannot happen (the sale went through with nobody
 * attached, or the money was taken some other way), staff activate it here
 * by hand. The till link is made when somebody asks to join online; "Link to
 * Epos Now" makes it for anybody else, or tries again after a failure. If
 * Epos Now is down the link waits and the server retries every five minutes,
 * so the button never leaves anybody stuck.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { ConfirmDialog } from "@/features/customers/ConfirmDialog"
import { formatShortDate } from "@/features/customers/format"
import { PlanSheet } from "@/features/loyalty/PlanSheet"
import { type MembershipForm } from "@/features/loyalty/mapping"
import { parseCount, penceToPounds, poundsToPence } from "@/features/settings/mapping"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  activateMembership,
  cancelMembership,
  getEposLink,
  linkToEposNow,
  pendingMembershipFor,
} from "@/lib/api/loyalty"
import { eposLinkSentence } from "@/features/customers/till"

export function TillSection({
  customerId,
  customerName,
  hasLivePlan,
}: {
  customerId: string
  customerName: string
  /** A live plan already pins the tier, so a pending one is not offered. */
  hasLivePlan: boolean
}) {
  const queryClient = useQueryClient()
  const [activating, setActivating] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const pending = useQuery({
    queryKey: ["membership-pending", customerId],
    queryFn: () => pendingMembershipFor(customerId),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  })
  const link = useQuery({
    queryKey: ["epos-link", customerId],
    queryFn: () => getEposLink(customerId),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  })

  function settle() {
    void queryClient.invalidateQueries({ queryKey: ["membership-pending", customerId] })
    void queryClient.invalidateQueries({ queryKey: ["customer-guild", customerId] })
    void queryClient.invalidateQueries({ queryKey: ["customer"] })
    void queryClient.invalidateQueries({ queryKey: ["memberships"] })
  }

  const activate = useMutation({
    mutationFn: ({ id, form }: { id: string; form: MembershipForm }) =>
      activateMembership(id, {
        months: parseCount(form.months) ?? 12,
        price: poundsToPence(form.price) ?? 0,
        payment_note: form.note.trim() || undefined,
        epos_transaction_id: form.eposTransaction.trim() || undefined,
      }),
    onSuccess: (membership) => {
      setError(null)
      setActivating(false)
      setNote(`${membership.tierName} is live. Renews ${formatShortDate(membership.renews_at)}.`)
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That membership was not activated. Try again.")),
  })

  const stop = useMutation({
    mutationFn: (id: string) => cancelMembership(id),
    onSuccess: () => {
      setError(null)
      setCancelling(false)
      setNote("The request to join is cancelled. Nothing was paid, so nothing is refunded.")
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That request was not cancelled. Try again.")),
  })

  const relink = useMutation({
    mutationFn: () => linkToEposNow(customerId),
    onSuccess: (result) => {
      setError(null)
      queryClient.setQueryData(["epos-link", customerId], result.link)
      setNote(
        result.link.status === "linked"
          ? `${customerName} is on the till. Their card scans at Epos Now.`
          : result.message
      )
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "The link did not go through. Try again in a minute.")),
  })

  const waiting = !hasLivePlan ? (pending.data ?? null) : null
  const till = link.data

  return (
    <div className="mt-6 max-w-[40rem]" data-testid="till-section">
      {waiting ? (
        <div
          data-testid="pending-plan"
          className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft pb-4"
        >
          <span className="text-[15px] text-foreground">{waiting.tierName}</span>
          <Hint>Waiting for payment</Hint>
          <span className="tnum text-[15px] text-foreground">{formatGBP(waiting.price)}</span>
          <Button variant="text" type="button" onClick={() => setActivating(true)}>
            Activate
          </Button>
          <Button variant="text-destructive" type="button" onClick={() => setCancelling(true)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        <span className="flex min-w-0 flex-col gap-1">
          <MicroLabel>Epos Now till</MicroLabel>
          <span data-testid="epos-link" className="max-w-[48ch] text-[15px] leading-[1.5] text-foreground">
            {till ? eposLinkSentence(till) : "Reading the till link."}
          </span>
        </span>
        {till && till.status !== "linked" && !till.eposCustomerId ? (
          <Button
            variant="text"
            type="button"
            loading={relink.isPending}
            onClick={() => relink.mutate()}
          >
            Link to Epos Now
          </Button>
        ) : null}
      </div>

      {note ? (
        <p aria-live="polite" className="text-[13px] leading-[1.45] text-muted-foreground-2">
          {note}
        </p>
      ) : null}
      {error && !activating && !cancelling ? (
        <p role="alert" className="text-[13px] leading-[1.45] text-destructive">
          {error}
        </p>
      ) : null}

      <PlanSheet
        open={activating && waiting !== null}
        onOpenChange={(open: boolean) => {
          setActivating(open)
          if (!open) setError(null)
        }}
        title="Activate"
        description={
          waiting
            ? `${customerName} asked to join ${waiting.tierName} online. Record what they paid at the counter.`
            : ""
        }
        customer={{ id: customerId, name: customerName }}
        tiers={null}
        initial={waiting ? { price: penceToPounds(waiting.price), tier: waiting.tier } : undefined}
        busy={activate.isPending}
        error={activating ? error : null}
        saveLabel="Activate"
        onSubmit={(form) => activate.mutateAsync({ id: waiting?.id ?? "", form })}
        onDismissError={() => setError(null)}
      />

      <ConfirmDialog
        open={cancelling && waiting !== null}
        onOpenChange={(open: boolean) => {
          setCancelling(open)
          if (!open) setError(null)
        }}
        title="Cancel this request"
        description={
          waiting
            ? `${customerName} asked to join ${waiting.tierName} and has not paid. They are told it was cancelled.`
            : ""
        }
        confirmLabel="Cancel the request"
        busy={stop.isPending}
        error={cancelling ? error : null}
        onConfirm={() => {
          if (!waiting) return
          void stop.mutateAsync(waiting.id).catch(() => {})
        }}
      />
    </div>
  )
}
