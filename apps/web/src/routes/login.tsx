import * as React from "react"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Wordmark } from "@/components/ui/wordmark"
import { DEMO_STAFF, isDemo, SignInError } from "@/lib/api"
import { currentStaff, login } from "@/lib/auth"

const searchSchema = z.object({
  /** Where the guard bounced them from, so sign-in puts them back. */
  redirect: z.string().optional(),
})

function SignIn() {
  const navigate = useNavigate()
  const { redirect: back } = Route.useSearch()
  const demo = isDemo()

  const [email, setEmail] = React.useState(demo ? DEMO_STAFF.email : "")
  const [password, setPassword] = React.useState(demo ? DEMO_STAFF.password : "")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
      await navigate({ to: back ?? "/counter" })
    } catch (cause) {
      setError(
        cause instanceof SignInError
          ? cause.message
          : "The counter could not reach the server. Check the connection and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between px-5 py-7 sm:px-10">
        <Wordmark mark />
        {demo ? <Hint>Demo data</Hint> : null}
      </header>

      <main className="mx-auto w-full max-w-[1040px] flex-1 px-5 pt-16 pb-16 sm:px-10 sm:pt-24">
        <PageTitle>Sign in</PageTitle>
        <Lede>The counter, the stock book and the Guild, behind one password.</Lede>

        <form
          className="mt-14 max-w-[520px]"
          onSubmit={submit}
          aria-label="Staff sign in"
        >
          <FieldRow>
            <Field
              layout="stacked"
              label="Email"
              htmlFor="signin-email"
              error={error}
            >
              <Input
                id="signin-email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                aria-invalid={error ? true : undefined}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>

            <Field layout="stacked" label="Password" htmlFor="signin-password">
              <Input
                id="signin-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                aria-invalid={error ? true : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </FieldRow>

          <div className="mt-14">
            <Button type="submit" trailingArrow loading={busy}>
              Sign in
            </Button>
          </div>
        </form>

        {demo ? (
          <div className="mt-16 flex flex-col gap-2">
            <MicroLabel>Demo account</MicroLabel>
            <p className="text-[15px] text-muted-foreground">
              {DEMO_STAFF.email} with the password {DEMO_STAFF.password}. Nothing is
              saved: the data resets on reload.
            </p>
          </div>
        ) : null}
      </main>
    </div>
  )
}

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  beforeLoad: () => {
    if (currentStaff()) throw redirect({ to: "/counter" })
  },
  component: SignIn,
})
