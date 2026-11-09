import * as React from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { confirmEmail, setNewPassword } from "@/lib/api/portal"

/** Opened from the confirmation email: confirms the address, then offers sign-in. */
export function VerifyEmailScreen({ token }: { token?: string }) {
  // A missing token fails before anything runs, so the effect never has to
  // set state synchronously.
  const [state, setState] = React.useState<"working" | "done" | "failed">(token ? "working" : "failed")

  React.useEffect(() => {
    if (!token) return
    confirmEmail(token).then(
      () => setState("done"),
      () => setState("failed")
    )
  }, [token])

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>
        {state === "done" ? "Email confirmed" : state === "failed" ? "Link not valid" : "Confirming"}
      </PageTitle>
      <Lede>
        {state === "done"
          ? "Your account is ready. Sign in with your email and password."
          : state === "failed"
            ? "That link has run out or has already been used. Sign in, and if your email still needs confirming we will offer to send a new link."
            : "One moment."}
      </Lede>
      {state !== "working" ? (
        <div className="mt-12">
          <Button trailingArrow render={<Link to="/account" />}>
            Go to sign in
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/** Opened from the password email: sets a new password. */
export function ResetPasswordScreen({ token }: { token?: string }) {
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(false)

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
    setBusy(true)
    try {
      await setNewPassword(token ?? "", password)
      setDone(true)
    } catch {
      setError("That link has run out or has already been used. Ask for a new one from the sign-in screen.")
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>Password set</PageTitle>
        <Lede>Sign in with your email and your new password.</Lede>
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
      <PageTitle>Set a new password</PageTitle>
      <form className="mt-12" onSubmit={submit} aria-label="Set a new password">
        <FieldRow>
          <Field layout="stacked" label="New password" htmlFor="reset-password" hint="At least 10 characters">
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field layout="stacked" label="Password again" htmlFor="reset-confirm" error={error}>
            <Input
              id="reset-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
        </FieldRow>
        <div className="mt-12">
          <Button type="submit" trailingArrow loading={busy}>
            Save password
          </Button>
        </div>
      </form>
    </section>
  )
}
