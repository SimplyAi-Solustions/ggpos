import * as React from "react"
import { Link } from "@tanstack/react-router"

import { Hint } from "@/components/ui/micro-label"
import { Wordmark } from "@/components/ui/wordmark"
import { EstimateScreen } from "@/features/estimate/EstimateScreen"
import { isDemo } from "@/lib/api/mode"
import { PortalDockContext } from "@/features/portal/dock"
import { useCustomerSession } from "@/features/portal/session"

/**
 * The public estimate page.
 *
 * Its own chrome rather than the portal shell: a visitor who has never been
 * in the shop has no card, no bottom bar and nothing to sign out of. The
 * column is the portal's, so the two pages read as one product when somebody
 * signs in from here, and it carries the same phone dock, so the one black
 * block button sits in the thumb zone here as it does everywhere else.
 */
export function PublicEstimatePage() {
  const signedIn = useCustomerSession()
  const demo = isDemo()
  const [dockSlot, setDockSlot] = React.useState<HTMLDivElement | null>(null)
  const dockRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const dock = dockRef.current
    if (!dock) return undefined
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty("--gg-portal-dock-h", `${dock.offsetHeight}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--gg-portal-dock-h")
    }
  }, [])

  return (
    <PortalDockContext.Provider value={dockSlot}>
      <div className="flex min-h-svh w-full flex-col bg-background">
        <header className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-6 px-5 py-6 sm:px-10">
          <Link to="/estimate" className="rounded-[var(--radius)] outline-none">
            <Wordmark mark name="GG Vault" />
          </Link>
          {demo ? <Hint>Demo</Hint> : null}
        </header>

        <main className="mx-auto w-full max-w-[560px] flex-1 px-5 pb-[calc(var(--gg-portal-dock-h,0px)+2.5rem)] sm:px-10 min-[900px]:pb-16">
          <EstimateScreen signedIn={Boolean(signedIn)} />
        </main>

        <footer className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-6 px-5 pb-8 sm:px-10">
          <Hint>GG Entertainment</Hint>
          <Hint>Game &middot; Trade &middot; Play</Hint>
        </footer>

        {/* The dock group: the screen's own block button and nothing else,
            because a signed-out visitor has no sections to tab between. */}
        <div
          ref={dockRef}
          className="fixed inset-x-0 bottom-0 z-40 min-[900px]:hidden"
        >
          <div
            ref={setDockSlot}
            className="bg-background pb-[env(safe-area-inset-bottom)]"
          />
        </div>
      </div>
    </PortalDockContext.Provider>
  )
}
