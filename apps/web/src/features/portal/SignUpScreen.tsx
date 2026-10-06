import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { getGuildTerms, requestCode, signUp } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import { SignInScreen } from "@/features/portal/SignInScreen"
import { validateSignUp, type SignUpErrors } from "@/features/portal/signup"

/**
 * Create a My Vault account: a name, an email address, the marketing choice
 * and the terms, then the same emailed code every sign-in uses.
 *
 * The same shape as the sign-in screen it hands over to: one Anton line,
 * underlined fields stacked, one black block button that stays in the flow.
 * The server answers the same whether the address is new or already on a
 * card, so this screen never says which; either way the next thing on screen
 * is the code step, and the code is what proves the address is theirs.
 */
export function SignUpScreen() {
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [marketing, setMarketing] = React.useState(false)
  const [terms, setTerms] = React.useState(false)
  const [errors, setErrors] = React.useState<SignUpErrors>({})
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [termsOpen, setTermsOpen] = React.useState(false)
  const [started, setStarted] = React.useState<{ email: string; otpId: string } | null>(
    null
  )

  const nameRef = React.useRef<HTMLInputElement>(null)
  const emailRef = React.useRef<HTMLInputElement>(null)

  const termsQuery = useQuery({
    queryKey: ["guild-terms"],
    queryFn: getGuildTerms,
    enabled: termsOpen,
    staleTime: 10 * 60_000,
  })

  if (started) {
    return <SignInScreen next="/account" start={started} />
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setRefusal(null)
    const found = validateSignUp({ name, email, terms })
    setErrors(found)
    if (found.name) {
      nameRef.current?.focus()
      return
    }
    if (found.email) {
      emailRef.current?.focus()
      return
    }
    if (found.terms) return

    setBusy(true)
    try {
      await signUp({
        name,
        email,
        marketing_consent: marketing,
        terms_accepted: terms,
      })
      const otpId = await requestCode(email)
      setStarted({ email: email.trim(), otpId })
    } catch (cause) {
      setRefusal(
        refusalOrFallback(
          cause,
          "We could not create your account just now. Try again in a minute."
        )
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Join GG Guild</PageTitle>
      <Lede>
        Points on what you buy and sell us, your card on your phone, and
        quotes from home.
      </Lede>

      <form className="mt-12" onSubmit={submit} noValidate aria-label="Create a My Vault account">
        <FieldRow>
          <Field
            layout="stacked"
            label="Name"
            htmlFor="signup-name"
            hint="Required"
            error={errors.name}
          >
            <Input
              id="signup-name"
              ref={nameRef}
              autoComplete="name"
              autoFocus
              maxLength={200}
              value={name}
              aria-invalid={errors.name ? true : undefined}
              placeholder="Your full name"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            layout="stacked"
            label="Email"
            htmlFor="signup-email"
            hint="Required"
            error={errors.email}
          >
            <Input
              id="signup-email"
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              value={email}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby="signup-email-help"
              placeholder="you@example.co.uk"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        </FieldRow>
        <p
          id="signup-email-help"
          className="mt-4 text-[15px] leading-[1.5] text-muted-foreground-2"
        >
          You sign in with a code we email here, so there is no password.
        </p>

        <ul className="mt-12 flex flex-col gap-8">
          <li className="flex items-start justify-between gap-6">
            <span className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor="signup-marketing"
                className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
              >
                Offers and news
              </label>
              <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                Email me about offers and events. Only if you say yes, and you
                can stop at any time.
              </span>
            </span>
            <Switch id="signup-marketing" checked={marketing} onCheckedChange={setMarketing} />
          </li>
          <li className="flex flex-col gap-2">
            <span className="flex items-start justify-between gap-6">
              <span className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor="signup-terms"
                  className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
                >
                  The terms
                </label>
                <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                  I accept the GG Guild terms and how my data is used.
                </span>
              </span>
              <Switch
                id="signup-terms"
                checked={terms}
                aria-invalid={errors.terms ? true : undefined}
                aria-describedby={errors.terms ? "signup-terms-error" : undefined}
                onCheckedChange={(next: boolean) => {
                  setTerms(next)
                  if (next) setErrors((current) => ({ ...current, terms: undefined }))
                }}
              />
            </span>
            {errors.terms ? (
              <p id="signup-terms-error" className="text-[13px] leading-[1.45] text-destructive">
                {errors.terms}
              </p>
            ) : null}
            <span>
              <Button type="button" variant="text" onClick={() => setTermsOpen(true)}>
                Read the terms
              </Button>
            </span>
          </li>
        </ul>

        {refusal ? (
          <p role="alert" className="mt-10 max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
            {refusal}
          </p>
        ) : null}

        <div className="mt-12 flex flex-col items-start gap-8">
          <Button type="submit" trailingArrow loading={busy}>
            Create my account
          </Button>
          <div className="flex flex-col items-start gap-2">
            <MicroLabel>Already have a card</MicroLabel>
            <Button variant="text" render={<Link to="/account" />}>
              Sign in
            </Button>
          </div>
        </div>
      </form>

      <Sheet open={termsOpen} onOpenChange={setTermsOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className={SHEET_COLUMN}>
            <SheetTitle>{termsQuery.data?.name ?? "GG Guild"} terms</SheetTitle>
            <SheetDescription>What you agree to by joining.</SheetDescription>
          </SheetHeader>
          <SheetBody className={SHEET_COLUMN}>
            {termsQuery.isPending ? <SkeletonText lines={4} /> : null}
            {termsQuery.isError ? (
              <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                The terms would not load. Check your connection and try again, or
                ask at the counter for a copy.
              </p>
            ) : null}
            {termsQuery.data ? (
              <div className="flex flex-col gap-6">
                <p className="max-w-[56ch] text-[15px] leading-[1.5] whitespace-pre-line text-muted-foreground">
                  {termsQuery.data.terms ||
                    "The shop has not written its programme terms yet. Ask at the counter for a copy."}
                </p>
                <div className="flex flex-col gap-1.5">
                  <MicroLabel tone="ink">Your data</MicroLabel>
                  <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                    We keep your name, email address, purchases, points and tier
                    to run GG Guild. If you join a paid plan, your name, email
                    address and card number are shared with Epos Now, our till,
                    so the counter can scan your card. We do not sell your data.
                    The full privacy notice is at the counter and in My Vault.
                  </p>
                </div>
              </div>
            ) : null}
          </SheetBody>
          <SheetFooter className={SHEET_COLUMN}>
            <Button type="button" variant="text" onClick={() => setTermsOpen(false)}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
