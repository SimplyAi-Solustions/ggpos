/**
 * The PIN lock (DESIGN.md section 10, "Lock screen and approval";
 * docs/api-contract-epos.md, section 2).
 *
 * A full-screen paper panel over the counter, not a dialog over a dimmed
 * page: the register's name top left, the time top right, "Locked" as the
 * one Anton line, and the register's staff as a grid of names. Tapping a
 * name replaces the grid with the PIN step; the last digit submits. A name
 * with no PIN, or a locked one, opens the password sign-in instead.
 *
 * Underneath it is a Base UI dialog with no backdrop, so it takes the focus
 * trap from anything already open on the till (a line sheet, the tender
 * step) and the rest of the page goes inert. The keyboard guard stops every
 * key at the window, so a PIN typed on the Mac's keyboard never reaches the
 * till's own keypad behind it.
 *
 * Unlocking stores the server's `{ token, record }` exactly as a password
 * sign-in does, so switching user keeps the screen and the till's ticket as
 * they were.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import type { RosterEntry } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Skeleton } from "@/components/ui/skeleton"
import { lockedRedirect } from "@/features/auth/gate"
import { forgetDevice } from "@/features/lock/device"
import { useKeyGuard } from "@/features/lock/key-guard"
import { unlockCounter } from "@/features/lock/lock-store"
import { NO_ANSWER, readRefusal } from "@/features/lock/pin"
import { PinStep, RosterTile } from "@/features/lock/PinStep"
import { ROSTER_KEY, firstName } from "@/features/lock/roster"
import { adoptSession } from "@/features/lock/session"
import { SignInError } from "@/lib/api"
import { getRoster, unlockWithPin } from "@/lib/api/staff"
import { login, useStaff } from "@/lib/auth"
import type { StaffRecord } from "@/lib/api/types"
import type { StoredTillDevice } from "@/lib/till-device"

type Step =
  | { kind: "roster" }
  | { kind: "pin"; member: RosterEntry }
  | { kind: "password"; member: RosterEntry | null }

/** "14:05", Space Mono, top right. Moves on the minute. */
function useClock(): string {
  const read = () =>
    new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
  const [time, setTime] = React.useState(read)
  React.useEffect(() => {
    const timer = window.setInterval(() => setTime(read()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return time
}

export function LockScreen({ device }: { device: StoredTillDevice }) {
  const staff = useStaff()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const queryClient = useQueryClient()
  const time = useClock()

  const [step, setStep] = React.useState<Step>({ kind: "roster" })
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const roster = useQuery({
    queryKey: [...ROSTER_KEY, device.id],
    queryFn: getRoster,
    // Somebody's PIN may have been set or reset since the till last locked.
    staleTime: 0,
    retry: false,
  })

  // Nothing behind the lock may hear a key, on every step.
  useKeyGuard({ active: true })

  React.useEffect(() => {
    const refusal = roster.error ? readRefusal(roster.error) : null
    // Revoked under Settings: this browser is no longer a till, so it drops
    // its copy and the counter falls back to the password lock.
    if (refusal?.kind === "device") forgetDevice()
  }, [roster.error])

  const back = () => {
    setStep({ kind: "roster" })
    setError(null)
  }

  const choose = (member: RosterEntry) => {
    setError(null)
    if (!member.pin_set || member.pin_locked) {
      setStep({ kind: "password", member })
      return
    }
    setStep({ kind: "pin", member })
  }

  async function finish(next: StaffRecord | null) {
    unlockCounter()
    setStep({ kind: "roster" })
    setError(null)
    void queryClient.invalidateQueries({ queryKey: ROSTER_KEY })
    // A new starter unlocked on a temporary password is held on the
    // password screen, the same as after a password sign-in.
    const held = lockedRedirect(next, pathname)
    if (held) await navigate({ to: held })
  }

  async function submitPin(member: RosterEntry, pin: string) {
    setBusy(true)
    setError(null)
    try {
      const auth = await unlockWithPin(member.id, pin)
      await finish(await adoptSession(auth))
    } catch (cause) {
      const refusal = readRefusal(cause)
      if (refusal.kind === "device") forgetDevice()
      setError(refusal.message)
      setAttempt((value) => value + 1)
      if (refusal.kind === "locked" || refusal.kind === "no_pin") {
        void roster.refetch()
      }
    } finally {
      setBusy(false)
    }
  }

  async function submitPassword(email: string, password: string) {
    setBusy(true)
    setError(null)
    try {
      const signedIn = await login(email, password)
      await finish(signedIn)
    } catch (cause) {
      setError(
        cause instanceof SignInError ? cause.message : NO_ANSWER
      )
    } finally {
      setBusy(false)
    }
  }

  const register = roster.data?.register.name || device.register_name || "Till"
  const people = roster.data?.staff ?? []
  const lockedOut =
    step.kind === "pin" &&
    (people.find((entry) => entry.id === step.member.id)?.pin_locked ?? step.member.pin_locked)

  return (
    <DialogPrimitive.Root open modal disablePointerDismissal onOpenChange={() => {}}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          data-slot="lock-screen"
          aria-labelledby="lock-title"
          className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-background text-foreground outline-none"
        >
          <header className="flex items-center justify-between gap-6 px-5 pt-6 sm:px-10">
            <MicroLabel tone="ink" data-testid="lock-register">
              {register}
            </MicroLabel>
            <span className="tnum font-mono text-[13px] text-foreground" aria-label={`The time is ${time}`}>
              {time}
            </span>
          </header>

          <main className="flex flex-1 flex-col items-center px-5 pt-12 pb-16 sm:px-10 sm:pt-20">
            <PageTitle id="lock-title" className="text-center">
              Locked
            </PageTitle>
            <Lede className="text-center">Tap your name and enter your PIN.</Lede>

            <div className="mt-12 flex w-full flex-col items-center sm:mt-14">
              {step.kind === "roster" ? (
                <RosterStep
                  loading={roster.isPending}
                  error={roster.error ? readRefusal(roster.error).message : null}
                  people={people}
                  onChoose={choose}
                  onRetry={() => void roster.refetch()}
                  onPassword={() => {
                    setError(null)
                    setStep({ kind: "password", member: null })
                  }}
                />
              ) : step.kind === "pin" ? (
                <PinStep
                  key={`${step.member.id}-${attempt}`}
                  name={step.member.name}
                  length={step.member.pin_length === 6 ? 6 : 4}
                  busy={busy}
                  error={error}
                  locked={lockedOut}
                  onSubmit={(pin) => void submitPin(step.member, pin)}
                  onBack={back}
                >
                  <Button variant="text" onClick={back}>
                    Back
                  </Button>
                  <Button
                    variant="text"
                    onClick={() => {
                      setError(null)
                      setStep({ kind: "password", member: step.member })
                    }}
                  >
                    Use password instead
                  </Button>
                </PinStep>
              ) : (
                <PasswordStep
                  member={step.member}
                  defaultEmail={
                    step.member && staff && step.member.id === staff.id ? staff.email : ""
                  }
                  busy={busy}
                  error={error}
                  onSubmit={submitPassword}
                  onBack={back}
                />
              )}
            </div>
          </main>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function RosterStep({
  loading,
  error,
  people,
  onChoose,
  onRetry,
  onPassword,
}: {
  loading: boolean
  error: string | null
  people: RosterEntry[]
  onChoose: (member: RosterEntry) => void
  onRetry: () => void
  onPassword: () => void
}) {
  if (loading) {
    return (
      <div aria-busy="true" className="flex justify-center gap-6">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex w-24 flex-col items-center gap-3 pt-2">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex max-w-[44ch] flex-col items-center gap-6 text-center">
        <p role="alert" className="text-[15px] leading-[1.5] text-destructive">
          {error}
        </p>
        <div className="flex flex-wrap justify-center gap-8">
          <Button variant="text" onClick={onRetry}>
            Try again
          </Button>
          <Button variant="text" onClick={onPassword}>
            Use password instead
          </Button>
        </div>
      </div>
    )
  }
  return (
    <ul
      aria-label="Staff on this till"
      className="grid w-full max-w-[720px] grid-cols-[repeat(auto-fit,6rem)] justify-center gap-x-6 gap-y-6"
    >
      {people.map((entry) => (
        <li key={entry.id}>
          <RosterTile entry={entry} onChoose={onChoose} />
        </li>
      ))}
    </ul>
  )
}

function PasswordStep({
  member,
  defaultEmail,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  member: RosterEntry | null
  defaultEmail: string
  busy: boolean
  error: string | null
  onSubmit: (email: string, password: string) => void
  onBack: () => void
}) {
  const [email, setEmail] = React.useState(defaultEmail)
  const [password, setPassword] = React.useState("")

  return (
    <form
      className="w-full max-w-[360px]"
      aria-label="Sign in with a password"
      onSubmit={(event) => {
        event.preventDefault()
        if (email.trim() && password) onSubmit(email, password)
      }}
    >
      <p className="text-center text-[20px] leading-[1.3] font-medium text-foreground">
        {member ? member.name : "Sign in"}
      </p>
      <p className="mt-2 text-center text-[13px] leading-[1.45] text-muted-foreground-2">
        {member && member.pin_locked
          ? `${firstName(member.name)}'s PIN is locked. A password sign-in unlocks it.`
          : member && !member.pin_set
            ? `${firstName(member.name)} has no PIN yet. Sign in with a password, then set one from the account menu.`
            : "Your email and password, as at the sign-in screen."}
      </p>

      <FieldRow className="mt-8">
        <Field layout="stacked" label="Email" htmlFor="lock-email">
          <Input
            id="lock-email"
            type="email"
            autoComplete="username"
            autoFocus={!defaultEmail}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field layout="stacked" label="Password" htmlFor="lock-password" error={error}>
          <Input
            id="lock-password"
            type="password"
            autoComplete="current-password"
            autoFocus={Boolean(defaultEmail)}
            value={password}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </FieldRow>

      <div className="mt-10 flex flex-wrap items-center gap-8">
        <Button
          type="submit"
          trailingArrow
          loading={busy}
          disabled={!email.trim() || !password}
          className="disabled:bg-surface-3 disabled:text-muted-foreground disabled:opacity-100"
        >
          Sign in
        </Button>
        <Button variant="text" onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  )
}
