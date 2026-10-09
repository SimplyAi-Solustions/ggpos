/**
 * Manager approval (DESIGN.md section 10, "Lock screen and approval";
 * docs/api-contract-epos.md, section 2, "Overrides").
 *
 * Mounted once in each frame of the counter shell, it registers itself with
 * `setOverrideHandler`, so `withOverride` anywhere on the counter can ask
 * for an approval and await a single-use token. A `Dialog`, because it is
 * the one till task that needs protected focus, and a bottom sheet on a
 * phone: "A manager needs to approve this.", what it is in Jost, the people
 * on this till who can approve it, then the PIN step. The approver's PIN
 * goes to `POST /api/vault/till/override` with this browser's device
 * header; the token it hands back resolves the request, and the caller
 * sends the same call again with it.
 *
 * Who can approve is worked out here with the shared `can()` and the
 * permissions table from the config route, so the dialog only offers
 * people the server will accept; the server checks again either way.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { can, type RosterEntry } from "@gg/shared"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { forgetDevice, useLockDevice } from "@/features/lock/device"
import { useKeyGuard } from "@/features/lock/key-guard"
import { isCounterLocked, subscribeLock, useCounterLocked } from "@/features/lock/lock-store"
import { setOverrideHandler, type OverrideRequest } from "@/features/lock/override"
import { readRefusal } from "@/features/lock/pin"
import { PinStep, RosterTile } from "@/features/lock/PinStep"
import { useCounterConfig } from "@/lib/api/config"
import { approveOverride, getRoster } from "@/lib/api/staff"
import { useStaff } from "@/lib/auth"
import { ROSTER_KEY, approvalLine } from "@/features/lock/roster"

interface Pending {
  request: OverrideRequest
  resolve: (token: string | null) => void
}

/**
 * The phone's bottom sheet: the same dialog, docked to the bottom edge in
 * the thumb zone below 640px, as every secondary panel is.
 */
const PHONE_SHEET =
  "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92svh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-b-none max-sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-sm:data-ending-style:translate-y-6 max-sm:data-starting-style:translate-y-6"

export function OverrideHost() {
  const [pending, setPending] = React.useState<Pending | null>(null)
  const locked = useCounterLocked()

  React.useEffect(
    () =>
      setOverrideHandler(
        (request) =>
          new Promise<string | null>((resolve) => {
            setPending((previous) => {
              // One approval at a time: an older one still open is given up.
              previous?.resolve(null)
              return { request, resolve }
            })
          })
      ),
    []
  )

  const finish = React.useCallback((token: string | null) => {
    setPending((current) => {
      current?.resolve(token)
      return null
    })
  }, [])

  // The counter locked itself while somebody was being asked: the request
  // is given up rather than left waiting behind the lock for the next
  // person to stumble on.
  React.useEffect(
    () =>
      subscribeLock(() => {
        if (isCounterLocked()) finish(null)
      }),
    [finish]
  )

  return (
    <Dialog
      open={pending !== null && !locked}
      onOpenChange={(open) => {
        if (!open) finish(null)
      }}
    >
      {pending ? (
        <DialogContent
          data-testid="override-dialog"
          showCloseButton={false}
          className={PHONE_SHEET}
        >
          <ApprovalBody
            key={pending.request.capability + pending.request.description}
            request={pending.request}
            onDone={finish}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function ApprovalBody({
  request,
  onDone,
}: {
  request: OverrideRequest
  onDone: (token: string | null) => void
}) {
  const staff = useStaff()
  const device = useLockDevice()
  const { data: config } = useCounterConfig()
  const [approver, setApprover] = React.useState<RosterEntry | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const roster = useQuery({
    queryKey: [...ROSTER_KEY, device?.id ?? "none"],
    queryFn: getRoster,
    enabled: device !== null,
    staleTime: 0,
    retry: false,
  })

  const table = config?.epos.permissions
  const approvers = (roster.data?.staff ?? []).filter(
    (entry) => entry.id !== staff?.id && can(entry.role, request.capability, table)
  )

  async function submit(entry: RosterEntry, pin: string) {
    setBusy(true)
    setError(null)
    try {
      const grant = await approveOverride({
        capability: request.capability,
        approver: entry.id,
        pin,
        context: request.context,
      })
      onDone(grant.token)
    } catch (cause) {
      const refusal = readRefusal(cause)
      if (refusal.kind === "device") forgetDevice()
      setError(refusal.message)
      setAttempt((value) => value + 1)
      if (refusal.kind === "locked") void roster.refetch()
    } finally {
      setBusy(false)
    }
  }

  const back = () => {
    setApprover(null)
    setError(null)
  }

  // The till behind the dialog never hears a key while it is open; on the
  // PIN step the step itself takes the digits and Esc goes back a step.
  useKeyGuard({ active: true, onEscape: approver ? undefined : () => onDone(null) })

  return (
    <>
      <DialogHeader>
        <DialogTitle>Manager approval</DialogTitle>
        <DialogDescription>A manager needs to approve this.</DialogDescription>
      </DialogHeader>
      <p data-testid="override-what" className="text-[20px] leading-[1.3] text-foreground">
        {approvalLine(request)}
      </p>

      {!device ? (
        <p className="text-[15px] leading-[1.5] text-muted-foreground">
          Approval with a PIN needs this browser registered as a till. A manager
          can register it under Settings, Tills.
        </p>
      ) : approver ? (
        <PinStep
          key={`${approver.id}-${attempt}`}
          className="mx-auto"
          name={approver.name}
          length={approver.pin_length === 6 ? 6 : 4}
          busy={busy}
          error={error}
          locked={approver.pin_locked}
          onSubmit={(pin) => void submit(approver, pin)}
          onBack={back}
        >
          <Button variant="text" onClick={back}>
            Back
          </Button>
          <Button variant="text" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </PinStep>
      ) : roster.isPending ? (
        <p className="text-[15px] text-muted-foreground-2" aria-busy="true">
          Finding who can approve this.
        </p>
      ) : roster.error ? (
        <p role="alert" className="text-[15px] leading-[1.5] text-destructive">
          {readRefusal(roster.error).message}
        </p>
      ) : approvers.length === 0 ? (
        <p className="text-[15px] leading-[1.5] text-muted-foreground">
          Nobody here can approve that. Ask an admin to check who may, under
          Settings, Permissions.
        </p>
      ) : (
        <ul
          aria-label="Who can approve this"
          className="grid grid-cols-[repeat(auto-fill,6rem)] justify-center gap-4"
        >
          {approvers.map((entry) => (
            <li key={entry.id}>
              <RosterTile
                entry={entry}
                disabled={!entry.pin_set || entry.pin_locked}
                onChoose={(chosen) => {
                  setError(null)
                  setApprover(chosen)
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {approver ? null : (
        <div className="mt-2 flex items-center gap-8">
          <Button variant="text" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </div>
      )}
    </>
  )
}
