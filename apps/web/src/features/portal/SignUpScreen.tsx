import * as React from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { signUp } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"

/**
 * Online sign-up: name, email, phone, address and a password. The account
 * works once the email address is confirmed from the link we send.
 */
export function SignUpScreen() {
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [address, setAddress] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [marketing, setMarketing] = React.useState(false)
  const [terms, setTerms] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (password.length < 10) {
      setError("Choose a password of at least 10 characters.")
      return
    }
    if (password !== confirm) {
      setError("The two passwords do not match. Type them again.")
      return
    }
    if (!terms) {
      setError("Tick the box to accept the terms and the privacy notice.")
      return
    }
    setBusy(true)
    try {
      const message = await signUp({
        name,
        email,
        phone,
        address,
        password,
        marketing_consent: marketing,
        terms_accepted: terms,
      })
      setDone(message)
    } catch (cause) {
      setError(refusalOrFallback(cause, "We could not create your account just now. Try again in a minute."))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>Check your email</PageTitle>
        <Lede>
          We have sent a link to {email}. Open it to confirm your address, then sign in with your
          password. If it has not arrived in a few minutes, check your junk folder.
        </Lede>
        <div className="mt-12">
          <Button trailingArrow render={<Link to="/account" />}>
            Go to sign in
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Create your account</PageTitle>
      <Lede>Build your binders, track the cards you want, and see what we have in the shop.</Lede>

      <form className="mt-12 flex flex-col gap-2" onSubmit={submit} aria-label="Create your account">
        <FieldRow>
          <Field layout="stacked" label="Name" htmlFor="signup-name" hint="Required">
            <Input
              id="signup-name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Email" htmlFor="signup-email" hint="Required">
            <Input
              id="signup-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              placeholder="you@example.co.uk"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Phone" htmlFor="signup-phone" hint="Required">
            <Input
              id="signup-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={phone}
              placeholder="07700 900123"
              onChange={(event) => setPhone(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Address" htmlFor="signup-address" hint="Including postcode">
            <Textarea
              id="signup-address"
              autoComplete="street-address"
              required
              rows={3}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Password" htmlFor="signup-password" hint="At least 10 characters">
            <Input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Password again" htmlFor="signup-confirm" error={error}>
            <Input
              id="signup-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
        </FieldRow>

        <ul className="mt-8 flex flex-col gap-6">
          <li className="flex items-start justify-between gap-6">
            <span className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor="signup-marketing"
                className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
              >
                News and offers by email
              </label>
              <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                New releases, events and stock in. Only if you say yes. You can stop at any time.
              </span>
            </span>
            <Switch id="signup-marketing" checked={marketing} onCheckedChange={setMarketing} />
          </li>
          <li className="flex items-start justify-between gap-6">
            <span className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor="signup-terms"
                className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
              >
                Terms and privacy
              </label>
              <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                I accept the terms and the privacy notice. We keep your details to run your account
                and never sell them.
              </span>
            </span>
            <Switch id="signup-terms" checked={terms} onCheckedChange={setTerms} />
          </li>
        </ul>

        <div className="mt-12 flex flex-col items-start gap-6">
          <Button type="submit" trailingArrow loading={busy}>
            Create account
          </Button>
          <Button type="button" variant="text" render={<Link to="/account" />}>
            I already have an account
          </Button>
        </div>
      </form>
    </section>
  )
}
