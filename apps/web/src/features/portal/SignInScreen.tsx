import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerCards } from "@/components/ui/sticker"
import { isDemo } from "@/lib/api/mode"
import { requestCode, signInWithCode } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"
import { DEMO_PORTAL_CODE, DEMO_PORTAL_EMAIL } from "@/lib/api/demo/portal-seed"
import {
  CODE_LENGTH,
  formatCodeForDisplay,
  isCompleteCode,
  normaliseCodeInput,
  RESEND_SECONDS,
} from "@/features/portal/code"
import { rememberDemoSession } from "@/features/portal/session"

/**
 * Sign in to My Vault with a code we email.
 *
 * The same shape as the counter's sign-in, with a code where the password
 * is: one Anton line, two underlined fields one after the other, one black
 * block button. There is no password to forget and no account to create
 * here, because the card is created at the counter; a customer with no email
 * on file is told to ask, rather than being left guessing why the code never
 * arrives.
 */
export function SignInScreen({ next }: { next?: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const demo = isDemo()

  const [step, setStep] = React.useState<"email" | "code">("email")
  const [email, setEmail] = React.useState(demo ? DEMO_PORTAL_EMAIL : "")
  const [otpId, setOtpId] = React.useState("")
  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [waitLeft, setWaitLeft] = React.useState(0)
  /** Said once, when the wait is armed, rather than ticked out loud. */
  const [announcement, setAnnouncement] = React.useState("")
  const codeRef = React.useRef<HTMLInputElement>(null)

  // "Send another" wakes up after a minute, so a slow mail server does not
  // get hammered and the customer is not left with a dead link.
  React.useEffect(() => {
    if (waitLeft <= 0) return undefined
    const timer = setTimeout(() => setWaitLeft((left) => left - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitLeft])

  async function send(event?: React.FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = await requestCode(email)
      setOtpId(id)
      setStep("code")
      setWaitLeft(RESEND_SECONDS)
      setAnnouncement(
        `Code sent. You can ask for another in ${RESEND_SECONDS} seconds.`
      )
      // The code field is not on screen until now, so focus waits a tick.
      window.setTimeout(() => codeRef.current?.focus(), 0)
    } catch (cause) {
      setError(
        refusalOrFallback(
          cause,
          "We could not send a code just now. Try again in a minute."
        )
      )
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const me = await signInWithCode(otpId, code)
      // The id the server answered with, not a constant: the demo shop has
      // more than one card, and the session has to remember which one.
      if (demo) rememberDemoSession(me.customer.id)
      await queryClient.invalidateQueries({ queryKey: ["portal"] })
      await navigate({ to: next ?? "/account" })
    } catch (cause) {
      setError(
        refusalOrFallback(cause, "That code does not match. Check it, or send another.")
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>My Vault</PageTitle>
      <Lede>
        Your Guild card, your trade-ins and your store credit, in one place.
      </Lede>

      {step === "email" ? (
        <form className="mt-12" onSubmit={send} aria-label="Sign in to My Vault">
          <FieldRow>
            <Field
              layout="stacked"
              label="Email"
              htmlFor="portal-email"
              hint="Required"
              error={error}
            >
              <Input
                id="portal-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                aria-invalid={error ? true : undefined}
                aria-describedby="portal-email-help"
                placeholder="you@example.co.uk"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          </FieldRow>

          <p
            id="portal-email-help"
            className="mt-4 text-[15px] leading-[1.5] text-muted-foreground-2"
          >
            Use the address on your Guild card. If we do not have one for you,
            ask at the counter and we will add it.
          </p>

          <div className="mt-12">
            <Button type="submit" trailingArrow loading={busy}>
              Send me a code
            </Button>
          </div>
        </form>
      ) : (
        <form className="mt-12" onSubmit={submitCode} aria-label="Enter your code">
          <FieldRow>
            <Field
              layout="stacked"
              label="Code"
              htmlFor="portal-code"
              hint={`${CODE_LENGTH} digits`}
              error={error}
            >
              <Input
                id="portal-code"
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                // A browser that fills this from the email app pastes the
                // whole line; `normaliseCodeInput` keeps the digits.
                pattern="[0-9]*"
                required
                value={code}
                aria-invalid={error ? true : undefined}
                aria-describedby="portal-code-help"
                className="tnum font-mono text-[24px] tracking-[0.24em]"
                onChange={(event) => setCode(normaliseCodeInput(event.target.value))}
                onPaste={(event) => {
                  event.preventDefault()
                  setCode(normaliseCodeInput(event.clipboardData.getData("text")))
                }}
              />
            </Field>
          </FieldRow>

          <p
            id="portal-code-help"
            className="mt-4 text-[15px] leading-[1.5] text-muted-foreground-2"
          >
            We sent it to {email}. It is good for ten minutes.
          </p>

          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>

          <div className="mt-12 flex flex-col items-start gap-8">
            <Button
              type="submit"
              trailingArrow
              loading={busy}
              disabled={!isCompleteCode(code)}
            >
              Sign in
            </Button>
            <div className="flex flex-col items-start gap-2">
              <Button
                type="button"
                variant="text"
                disabled={waitLeft > 0 || busy}
                onClick={() => void send()}
              >
                Send another
              </Button>
              {waitLeft > 0 ? (
                // Silent: a live region that reads a new number every second
                // would talk over the whole screen. The one announcement
                // that matters is made below, when the wait starts.
                <Hint aria-live="off">
                  {`Ready in ${waitLeft} ${waitLeft === 1 ? "second" : "seconds"}`}
                </Hint>
              ) : null}
            </div>
            <Button
              type="button"
              variant="text"
              onClick={() => {
                setStep("email")
                setCode("")
                setError(null)
              }}
            >
              Use another email
            </Button>
          </div>
        </form>
      )}

      {demo ? (
        <div className="mt-16 flex items-start gap-5">
          <StickerCards className="size-12" />
          <div className="flex flex-col gap-2">
            <MicroLabel>Demo card</MicroLabel>
            <p className="text-[15px] leading-[1.5] text-muted-foreground">
              {DEMO_PORTAL_EMAIL} with the code{" "}
              {formatCodeForDisplay(DEMO_PORTAL_CODE)}. Nothing is saved: the
              data resets on reload.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
