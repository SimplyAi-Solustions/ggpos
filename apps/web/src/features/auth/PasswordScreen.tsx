import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { checkNewPassword, isLocked, type PasswordField } from "@/features/auth/gate"
import { changePassword, currentStaff, useStaff } from "@/lib/auth"
import { PasswordChangeError } from "@/lib/api"

/**
 * Set a new password.
 *
 * Two ways in, one screen. A staff member whose account still carries
 * `must_change_password` is sent here by the counter's guard and can reach
 * nothing else until it is done; anybody else opens it from their own menu
 * and keeps the counter around them. The only difference on screen is the
 * lede, so the first sign-in says why it is being asked.
 *
 * The same sentence about length and reuse is checked here and on the
 * server (`pb/pb_hooks/staff.pb.js`): the screen so nothing is sent that
 * cannot work, the server because it is the only thing that can be trusted.
 */
export function PasswordScreen() {
  const staff = useStaff()
  const navigate = useNavigate()

  // Whether this was the locked way in, read once: the flag clears the
  // moment the change goes through, and the lede must not change under the
  // person's hands while the screen is still on.
  const [wasLocked] = React.useState(() => isLocked(staff))

  const [current, setCurrent] = React.useState("")
  const [next, setNext] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [problem, setProblem] = React.useState<{
    field: PasswordField | null
    message: string
  } | null>(null)
  const [busy, setBusy] = React.useState(false)

  const currentRef = React.useRef<HTMLInputElement>(null)
  const nextRef = React.useRef<HTMLInputElement>(null)
  const confirmRef = React.useRef<HTMLInputElement>(null)

  const errorFor = (field: PasswordField) =>
    problem && problem.field === field ? problem.message : null

  // A refusal belongs to one of the three fields, so put the cursor in it
  // rather than leaving a keyboard user to shift-tab back up the form.
  // Keyed on the whole `problem` object, so the same refusal twice running
  // moves the focus both times.
  React.useEffect(() => {
    const field = problem?.field
    if (!field) return
    const target =
      field === "current"
        ? currentRef.current
        : field === "next"
          ? nextRef.current
          : confirmRef.current
    target?.focus()
  }, [problem])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const refusal = checkNewPassword({ current, next, confirm })
    if (refusal) {
      setProblem(refusal)
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      await changePassword(current, next)
      setCurrent("")
      setNext("")
      setConfirm("")
      await navigate({ to: "/counter" })
    } catch (cause) {
      setProblem({
        // A refusal from the server is about one of the two passwords sent;
        // it is shown under the current one, which is the field the person
        // can do something about without retyping the rest.
        field: "current",
        message:
          cause instanceof PasswordChangeError
            ? cause.message
            : "The counter could not reach the server. Check the connection and try again.",
      })
      // The change went through but the sign-in after it did not, so there
      // is no session left to stay on this screen with. Sign-in is where
      // the new password works.
      if (!currentStaff()) await navigate({ to: "/login" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Set a new password</PageTitle>
      <Lede>
        {wasLocked
          ? "This is your first sign-in. Choose a password only you know."
          : "Choose a password only you know."}
      </Lede>

      <form
        className="mt-14 max-w-[520px]"
        onSubmit={submit}
        aria-label="Set a new password"
      >
        <FieldRow>
          <Field
            layout="stacked"
            label="Current password"
            htmlFor="password-current"
            error={errorFor("current")}
          >
            <Input
              id="password-current"
              ref={currentRef}
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={current}
              aria-invalid={errorFor("current") ? true : undefined}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>

          <Field
            layout="stacked"
            label="New password"
            hint="At least 12 characters"
            htmlFor="password-new"
            error={errorFor("next")}
          >
            <Input
              id="password-new"
              ref={nextRef}
              type="password"
              autoComplete="new-password"
              required
              value={next}
              aria-invalid={errorFor("next") ? true : undefined}
              onChange={(event) => setNext(event.target.value)}
            />
          </Field>

          <Field
            layout="stacked"
            label="New password again"
            htmlFor="password-confirm"
            error={errorFor("confirm")}
          >
            <Input
              id="password-confirm"
              ref={confirmRef}
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              aria-invalid={errorFor("confirm") ? true : undefined}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
        </FieldRow>

        <div className="mt-14">
          <Button type="submit" trailingArrow loading={busy}>
            Save and continue
          </Button>
        </div>
      </form>
    </section>
  )
}
