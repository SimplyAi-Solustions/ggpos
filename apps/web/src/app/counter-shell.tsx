import * as React from "react"
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeftRightIcon,
  EllipsisIcon,
  LayersIcon,
  ReceiptIcon,
} from "lucide-react"
import { cn } from "cn"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BarcodeGlyph } from "@/components/ui/icons"
import { Hint } from "@/components/ui/micro-label"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuPrimitive,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Wordmark } from "@/components/ui/wordmark"
import { useTheme } from "@/components/theme-provider"
import { CommandPalette } from "@/app/command-palette"
import { CounterDockContext } from "@/app/counter-dock"
import { dispatchScan, makeScanFallback } from "@/app/scan-bus"
import { useShortcuts } from "@/app/shortcuts"
import { PageMain } from "@/app/page-transition"
import { ShortcutOverlay } from "@/app/shortcut-overlay"
import { isScanField } from "@/app/focus-registry"
import { createWedgeListener } from "@/lib/scanning/wedge"
import { initials, logout, useStaff } from "@/lib/auth"
import { isDemo, isServerUnreachable, setSimulatedOffline } from "@/lib/api"
import { netSnapshot, subscribeNet } from "@/lib/offline/net"
import { OfflineStrip } from "@/lib/offline/OfflineStrip"
import { ServerUnreachable } from "@/app/server-unreachable"
import { CounterLock } from "@/features/lock/CounterLock"
import { isCounterLocked, lockCounter } from "@/features/lock/lock-store"
import { OverrideHost } from "@/features/lock/OverrideHost"
import { isManagerUp, useStaffRole } from "@/features/lock/role"
import { SetPinSheet } from "@/features/lock/SetPinSheet"

/**
 * The till is the shop's everyday screen, so it leads the nav and the thumb
 * bar, in the place Sell had. Paths are plain strings rather than literals:
 * the till's route is its own package's, and a string keeps this list
 * honest about that without a type check against a route tree it cannot
 * see.
 */
const NAV: { to: string; label: string }[] = [
  { to: "/counter/till", label: "Till" },
  { to: "/counter/stock", label: "Stock" },
  { to: "/counter/trade", label: "Trade" },
  { to: "/counter/customers", label: "Customers" },
  { to: "/counter/reports", label: "Reports" },
]

/**
 * Five slots on a phone: the till, the camera scan, stock and trade, then
 * More. Home is the wordmark, top left, and the first line of More.
 */
const BAR: {
  to: string
  label: string
  exact: boolean
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>
}[] = [
  { to: "/counter/till", label: "Till", exact: false, Icon: ReceiptIcon },
  { to: "/counter/scan", label: "Scan", exact: false, Icon: BarcodeGlyph },
  { to: "/counter/stock", label: "Stock", exact: false, Icon: LayersIcon },
  { to: "/counter/trade", label: "Trade", exact: false, Icon: ArrowLeftRightIcon },
]

function AvatarMenu({ onSetPin }: { onSetPin: () => void }) {
  const staff = useStaff()
  const role = useStaffRole()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  // Demo mode only: one switch so the offline queue can be walked, shown to
  // staff and tested without unplugging anything.
  const demo = isDemo()
  const net = React.useSyncExternalStore(subscribeNet, netSnapshot)

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={staff ? `Account menu for ${staff.name}` : "Account menu"}
            className="rounded-full outline-none"
          />
        }
      >
        <Avatar>
          <AvatarFallback>{initials(staff?.name ?? "")}</AvatarFallback>
        </Avatar>
      </MenuTrigger>
      <MenuContent>
        {/* The signed-in name is a group label, and Base UI refuses one
            outside a group: without this the menu throws the moment it
            opens. */}
        <MenuPrimitive.Group>
          <MenuLabel>{staff?.name ?? "Signed in"}</MenuLabel>
          <MenuItem onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <span>Night mode</span>
            <Hint>{theme === "dark" ? "On" : "Off"}</Hint>
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/account" })}>My Vault</MenuItem>
          {/* Everybody's own: the password goes through
              POST /api/vault/staff/me/password, which works for every role,
              and the PIN is the one the lock screen takes. */}
          <MenuItem onClick={onSetPin}>Set PIN</MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/counter/password" })}>
            Change password
          </MenuItem>
          {role === "admin" ? (
            <MenuItem onClick={() => void navigate({ to: "/counter/staff" })}>Staff</MenuItem>
          ) : null}
          {/* A manager registers tills, so a manager sees the Tills part of
              Settings; everything else there stays an admin's. */}
          {isManagerUp(role) ? (
            <MenuItem onClick={() => void navigate({ to: "/counter/settings" })}>
              Settings
            </MenuItem>
          ) : null}
          {demo ? (
            <MenuItem onClick={() => setSimulatedOffline(!net.simulated)}>
              <span>Simulate offline</span>
              <Hint>{net.simulated ? "On" : "Off"}</Hint>
            </MenuItem>
          ) : null}
        </MenuPrimitive.Group>
        <MenuSeparator />
        <MenuItem onClick={() => lockCounter()}>Lock</MenuItem>
        <MenuItem
          onClick={() => {
            logout()
            void navigate({ to: "/login" })
          }}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/**
 * How many quotes are waiting on somebody at the counter.
 *
 * The module is imported at call time rather than at the top of this file:
 * the shell is the entry chunk, and `lib/api/quotes` carries the demo shop
 * with it, which belongs in the quotes route's own chunk. Zero while it
 * loads, and zero on a failure, so the nav never shows a number it cannot
 * stand behind.
 */
function useQuotesWaiting(): number {
  const { data = 0 } = useQuery({
    queryKey: ["quotes-waiting"],
    queryFn: () =>
      import("@/lib/api/quotes").then((module) => module.countQuotesWaiting()),
    staleTime: 60_000,
  })
  return data
}

/** The count as a Space Mono superscript, and in words for a screen reader. */
function WaitingCount({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <>
      <sup
        data-testid="nav-quote-count"
        aria-hidden="true"
        className="tnum ml-1 font-mono text-[11px] font-bold tracking-[0.08em] text-foreground"
      >
        {count}
      </sup>
      <span className="sr-only">
        , {count} {count === 1 ? "quote" : "quotes"} waiting
      </span>
    </>
  )
}

function MoreSheet({
  open,
  onOpenChange,
  onSetPin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSetPin: () => void
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const role = useStaffRole()
  const admin = role === "admin"

  const go = (to: string) => {
    onOpenChange(false)
    void navigate({ to })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>More</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <ul className="flex flex-col">
            {[
              { label: "Home", to: "/counter" },
              { label: "Cash up", to: "/counter/cash" },
              { label: "Quotes", to: "/counter/quotes" },
              { label: "Customers", to: "/counter/customers" },
              { label: "Reports", to: "/counter/reports" },
              { label: "Exports and imports", to: "/counter/exports" },
              { label: "Add stock", to: "/counter/stock/new" },
              // The Guild and Staff are admin screens and say so to anybody
              // else, so the sheet does not offer them to anybody else.
              ...(admin ? [{ label: "Loyalty", to: "/counter/loyalty" }] : []),
              ...(admin ? [{ label: "Staff", to: "/counter/staff" }] : []),
              ...(isManagerUp(role) ? [{ label: "Settings", to: "/counter/settings" }] : []),
              { label: "My Vault", to: "/account" },
              { label: "Change password", to: "/counter/password" },
            ].map((entry) => (
              <li key={entry.to} className="border-b border-hairline-soft">
                <button
                  type="button"
                  onClick={() => go(entry.to)}
                  className="flex min-h-12 w-full items-center text-left text-base text-foreground"
                >
                  {entry.label}
                </button>
              </li>
            ))}
            <li className="border-b border-hairline-soft">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  onSetPin()
                }}
                className="flex min-h-12 w-full items-center text-left text-base text-foreground"
              >
                Set PIN
              </button>
            </li>
            <li className="border-b border-hairline-soft">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  lockCounter()
                }}
                className="flex min-h-12 w-full items-center text-left text-base text-foreground"
              >
                Lock
              </button>
            </li>
            <li className="border-b border-hairline-soft">
              <button
                type="button"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="flex min-h-12 w-full items-center justify-between gap-4 text-left text-base text-foreground"
              >
                <span>Night mode</span>
                <Hint>{theme === "dark" ? "On" : "Off"}</Hint>
              </button>
            </li>
          </ul>
          <div className="mt-8">
            <Button
              variant="text-destructive"
              onClick={() => {
                onOpenChange(false)
                logout()
                void navigate({ to: "/login" })
              }}
            >
              Sign out
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The counter chrome: the wordmark and text links on desktop, a five-slot
 * thumb bar on phones, the command palette, the global wedge listener and
 * the idle lock. Header, content and footer share the 1,040px column, so the
 * wordmark, the page title and the primary button sit on one left edge.
 */
export function CounterShell() {
  const navigate = useNavigate()
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [pinOpen, setPinOpen] = React.useState(false)
  const openPin = React.useCallback(() => setPinOpen(true), [])
  const [dockSlot, setDockSlot] = React.useState<HTMLDivElement | null>(null)
  const dockRef = React.useRef<HTMLDivElement>(null)
  const demo = isDemo()
  const waiting = useQuotesWaiting()
  const tillMode = useRouterState({
    select: (state) => /^\/counter\/till(\/|$)/.test(state.location.pathname),
  })

  const openPalette = React.useCallback(() => setPaletteOpen(true), [])
  const openShortcuts = React.useCallback(() => setShortcutsOpen(true), [])
  useShortcuts({ openPalette, openShortcuts })

  React.useEffect(() => {
    const fallback = makeScanFallback(navigate)
    return createWedgeListener({
      // A scan at a locked counter goes nowhere: the till behind the lock
      // must not take an item on somebody else's ticket.
      onScan: (raw) => {
        if (isCounterLocked()) return
        dispatchScan(raw, fallback)
      },
      isScanField,
    })
  }, [navigate])

  // Publish the fixed group's real height, safe-area inset and any docked
  // button included, so the content column reserves exactly that much room
  // rather than a guessed number that drifts when the bar changes.
  React.useEffect(() => {
    const dock = dockRef.current
    if (!dock) return undefined
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty("--gg-dock-h", `${dock.offsetHeight}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--gg-dock-h")
    }
    // The dock only exists outside the till, so measure it again on the way
    // back from there.
  }, [tillMode])

  // A production build with no PocketBase behind it: nothing else on this
  // shell can be trusted, so show only the paper state and nothing more.
  if (isServerUnreachable()) {
    return <ServerUnreachable />
  }

  // The till is the one full-bleed counter screen (DESIGN.md, "The till",
  // "Frame"): no header, nav, footer, thumb bar or column, because it draws
  // its own header and fills the tablet edge to edge. The wedge listener,
  // the palette, the shortcuts and the lock stay.
  if (tillMode) {
    return (
      <CounterDockContext.Provider value={null}>
        <div className="flex min-h-svh w-full flex-col bg-background">
          <OfflineStrip />
          <main id="counter-main" className="flex min-h-0 w-full flex-1 flex-col">
            <Outlet />
          </main>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onShowShortcuts={openShortcuts}
          />
          <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <OverrideHost />
          <CounterLock />
        </div>
      </CounterDockContext.Provider>
    )
  }

  return (
    <CounterDockContext.Provider value={dockSlot}>
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-6 px-5 py-7 sm:px-10">
        <Link to="/counter" className="rounded-[var(--radius)] outline-none">
          <Wordmark mark />
        </Link>

        <nav className="flex items-center gap-6 sm:gap-8" aria-label="Main">
          <ul className="hidden items-center gap-8 min-[900px]:flex">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: false }}
                  className="relative pb-1 text-[15px] text-muted-foreground-2 transition-colors duration-150 ease-gg hover:text-foreground data-[status=active]:text-foreground data-[status=active]:after:absolute data-[status=active]:after:inset-x-0 data-[status=active]:after:-bottom-px data-[status=active]:after:h-0.5 data-[status=active]:after:bg-volt"
                >
                  {item.label}
                  {item.to === "/counter/trade" ? (
                    <WaitingCount count={waiting} />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          {demo ? <Badge variant="outline">Demo</Badge> : null}
          <AvatarMenu onSetPin={openPin} />
        </nav>
      </header>

      {/* One hairline line, and only when the queue or the connection has
          something to say. */}
      <OfflineStrip />

      <PageMain
        id="counter-main"
        className="mx-auto w-full max-w-[1040px] flex-1 px-5 pb-[calc(var(--gg-dock-h,5rem)+2.5rem)] sm:px-10 min-[900px]:pb-16"
      >
        <Outlet />
      </PageMain>

      <footer className="mx-auto hidden w-full max-w-[1040px] items-center justify-between gap-6 px-5 pb-8 sm:px-10 min-[900px]:flex">
        <Hint>Game &middot; Trade &middot; Play</Hint>
        <Hint>GG Vault</Hint>
      </footer>

      {/* Phones: one fixed group in the thumb zone. A screen's docked block
          button goes in the slot, directly on top of the tab bar, so no strip
          of the page can ever show between the two. */}
      <div
        ref={dockRef}
        className="fixed inset-x-0 bottom-0 z-40 min-[900px]:hidden"
      >
      <div ref={setDockSlot} />
      <nav
        aria-label="Counter"
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
                  {to === "/counter/trade" ? <WaitingCount count={waiting} /> : null}
                </span>
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className="flex min-h-12 w-full flex-col items-center justify-center gap-1 py-2 text-muted-foreground-2"
            >
              <EllipsisIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
              <span className="font-mono text-[11px] leading-none font-bold tracking-[0.08em] uppercase">
                More
              </span>
            </button>
          </li>
        </ul>
      </nav>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onShowShortcuts={openShortcuts}
      />
      <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} onSetPin={openPin} />
      <SetPinSheet open={pinOpen} onOpenChange={setPinOpen} />
      <OverrideHost />
      <CounterLock />
    </div>
    </CounterDockContext.Provider>
  )
}
