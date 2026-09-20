import { Link } from "@tanstack/react-router"

import { Hint } from "@/components/ui/micro-label"
import { Wordmark } from "@/components/ui/wordmark"
import { EstimateScreen } from "@/features/estimate/EstimateScreen"
import { isDemo } from "@/lib/api/mode"
import { useCustomerSession } from "@/features/portal/session"

/**
 * The public estimate page.
 *
 * Its own chrome rather than the portal shell: a visitor who has never been
 * in the shop has no card, no bottom bar and nothing to sign out of. The
 * column is the portal's, so the two pages read as one product when somebody
 * signs in from here.
 */
export function PublicEstimatePage() {
  const signedIn = useCustomerSession()
  const demo = isDemo()

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-6 px-5 py-6 sm:px-10">
        <Link to="/estimate" className="rounded-[var(--radius)] outline-none">
          <Wordmark mark name="GG Vault" />
        </Link>
        {demo ? <Hint>Demo</Hint> : null}
      </header>

      <main className="mx-auto w-full max-w-[560px] flex-1 px-5 pb-16 sm:px-10">
        <EstimateScreen signedIn={Boolean(signedIn)} />
      </main>

      <footer className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-6 px-5 pb-8 sm:px-10">
        <Hint>GG Entertainment</Hint>
        <Hint>Game &middot; Trade &middot; Play</Hint>
      </footer>
    </div>
  )
}
