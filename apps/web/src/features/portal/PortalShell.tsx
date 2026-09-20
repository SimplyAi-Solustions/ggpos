import * as React from "react"
import { Link, Outlet } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  BellIcon,
  CameraIcon,
  CreditCardIcon,
  HeartIcon,
  UserIcon,
  WalletIcon,
} from "lucide-react"
import { cn } from "cn"

import { Wordmark } from "@/components/ui/wordmark"
import { Hint } from "@/components/ui/micro-label"
import { isDemo } from "@/lib/api/mode"
import { listMyNotifications } from "@/lib/api/notifications"
import { PortalDockContext } from "@/features/portal/dock"
import { useCustomerSession } from "@/features/portal/session"

/**
 * The portal chrome.
 *
 * A phone is personal, so there is no idle lock and no shared-counter
 * behaviour here: the wordmark, a five-slot thumb bar, and the notification
 * bell with its unread count. At 1440 the bar becomes text links and the
 * whole thing sits in a narrow centred column, which is what a page built
 * for one person in one hand should look like on a desk.
 */

const BAR = [
  { to: "/account", label: "Card", exact: true, Icon: CreditCardIcon },
  { to: "/account/quotes", label: "Quotes", exact: false, Icon: CameraIcon },
  { to: "/account/wants", label: "Wants", exact: false, Icon: HeartIcon },
  { to: "/account/credit", label: "Credit", exact: false, Icon: WalletIcon },
  { to: "/account/me", label: "Me", exact: false, Icon: UserIcon },
] as const

function NotificationsLink() {
  const signedIn = useCustomerSession()
  const { data } = useQuery({
    queryKey: ["portal", "notifications"],
    queryFn: listMyNotifications,
    enabled: Boolean(signedIn),
    staleTime: 30_000,
  })
  const unread = (data ?? []).filter((row) => !row.read_at).length

  if (!signedIn) return null

  return (
    <Link
      to="/account/notifications"
      aria-label={
        unread > 0 ? `Notifications, ${unread} unread` : "Notifications, none unread"
      }
      className="relative flex size-12 items-center justify-center rounded-[var(--radius)] text-foreground transition-colors duration-150 ease-gg hover:bg-secondary sm:size-10"
    >
      <BellIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          className="tnum absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[11px] leading-4 font-bold text-primary-foreground sm:top-0.5 sm:right-0.5"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  )
}

export function PortalShell() {
  const [dockSlot, setDockSlot] = React.useState<HTMLDivElement | null>(null)
  const dockRef = React.useRef<HTMLDivElement>(null)
  const signedIn = useCustomerSession()
  const demo = isDemo()

  // Publish the fixed group's real height, safe-area inset and any docked
  // button included, so the column reserves exactly that much room.
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
  }, [signedIn])

  return (
    <PortalDockContext.Provider value={dockSlot}>
      <div className="flex min-h-svh w-full flex-col bg-background">
        <header className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-6 px-5 py-6 sm:px-10">
          <Link to="/account" className="rounded-[var(--radius)] outline-none">
            <Wordmark mark name="My Vault" />
          </Link>
          <div className="flex items-center gap-3">
            {demo ? <Hint>Demo</Hint> : null}
            <NotificationsLink />
          </div>
        </header>

        {signedIn ? (
          <nav
            aria-label="My Vault"
            className="mx-auto hidden w-full max-w-[560px] px-5 pb-2 min-[900px]:block sm:px-10"
          >
            <ul className="flex items-center gap-8">
              {BAR.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.exact }}
                    className="relative pb-1 text-[15px] text-muted-foreground-2 transition-colors duration-150 ease-gg hover:text-foreground data-[status=active]:text-foreground data-[status=active]:after:absolute data-[status=active]:after:inset-x-0 data-[status=active]:after:-bottom-px data-[status=active]:after:h-0.5 data-[status=active]:after:bg-volt"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <main
          id="portal-main"
          className={cn(
            "mx-auto w-full max-w-[560px] flex-1 px-5 sm:px-10",
            signedIn
              ? "pb-[calc(var(--gg-portal-dock-h,5rem)+2.5rem)] min-[900px]:pb-16"
              : "pb-16"
          )}
        >
          <Outlet />
        </main>

        <footer className="mx-auto hidden w-full max-w-[560px] items-center justify-between gap-6 px-5 pb-8 sm:px-10 min-[900px]:flex">
          <Hint>Game &middot; Trade &middot; Play</Hint>
          <Hint>GG Guild</Hint>
        </footer>

        {signedIn ? (
          <div
            ref={dockRef}
            className="fixed inset-x-0 bottom-0 z-40 min-[900px]:hidden"
          >
            <div ref={setDockSlot} />
            <nav
              aria-label="Sections"
              className="border-t border-hairline-soft bg-background pb-[env(safe-area-inset-bottom)]"
            >
              <ul className="flex items-stretch">
                {BAR.map(({ to, label, exact, Icon }) => (
                  <li key={to} className="flex-1">
                    <Link
                      to={to}
                      activeOptions={{ exact }}
                      className={cn(
                        "flex min-h-12 flex-col items-center justify-center gap-1 py-2",
                        "text-muted-foreground-2 transition-colors duration-150 ease-gg",
                        "data-[status=active]:text-foreground"
                      )}
                    >
                      <Icon aria-hidden="true" className="size-5 stroke-[1.25]" />
                      <span className="font-mono text-[11px] leading-none font-bold tracking-[0.08em] uppercase">
                        {label}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        ) : null}
      </div>
    </PortalDockContext.Provider>
  )
}
