import * as React from "react"
import { motion } from "motion/react"
import { Lock, Mail } from "lucide-react"

import { GGLogo } from "@/brand/Logo"
import { SignInError, signIn } from "@/lib/auth"
import { ThemeToggle } from "@/shell/ThemeToggle"
import { Button, Input, Panel } from "@/ui"

export interface LoginPageProps {
  /** Called after a successful sign-in. */
  onSignedIn: () => void
}

export function LoginPage({ onSignedIn }: LoginPageProps) {
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError("Enter your email and password.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
      onSignedIn()
    } catch (err) {
      setError(
        err instanceof SignInError
          ? err.message
          : "Could not sign in. Check the connection and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 pt-[calc(var(--safe-top)+24px)] pb-[calc(var(--safe-bottom)+24px)]">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-volt/30 blur-[120px] dark:bg-volt/12" />
      <div aria-hidden className="pointer-events-none absolute -bottom-40 -right-20 size-[28rem] rounded-full bg-pop/25 blur-[120px] dark:bg-pop/15" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <GGLogo className="h-14" />
          <div>
            <p className="label-mono text-pop-text">Staff only</p>
            <h1 className="font-display text-5xl uppercase tracking-wide">GG Vault</h1>
          </div>
        </div>

        <Panel className="p-5 sm:p-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label="Email"
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              leading={<Mail aria-hidden />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              leading={<Lock aria-hidden />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error}
            />
            <Button type="submit" size="lg" block loading={busy}>
              Sign in
            </Button>
          </form>
        </Panel>

        <div className="mt-6 flex justify-center">
          <ThemeToggle />
        </div>
      </motion.div>
    </div>
  )
}
