import { Outlet } from "@tanstack/react-router"

import { Hint } from "@/components/ui/micro-label"
import { Wordmark } from "@/components/ui/wordmark"
import { isDemo } from "@/lib/api"

/**
 * The counter with nothing on it but the screen in front of you.
 *
 * While a staff member's account carries `must_change_password` this stands
 * in for `CounterShell`: no nav, no thumb bar, no command palette, no
 * keyboard shortcuts, no wedge scanner listener and no idle lock, because
 * none of those may run for an account that has not finished signing in.
 * The chrome is the same wordmark row the sign-in screen carries, which is
 * what this screen is a continuation of.
 */
export function LockedShell() {
  const demo = isDemo()

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between px-5 py-7 sm:px-10">
        <Wordmark mark />
        {demo ? <Hint>Demo data</Hint> : null}
      </header>

      <main className="mx-auto w-full max-w-[1040px] flex-1 px-5 pb-16 sm:px-10">
        <Outlet />
      </main>
    </div>
  )
}
