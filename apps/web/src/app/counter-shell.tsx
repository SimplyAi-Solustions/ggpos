import * as React from "react"
import { Link, Outlet, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeftRightIcon,
  EllipsisIcon,
  HouseIcon,
  LayersIcon,
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
import { IdleLock } from "@/app/idle-lock"
import { dispatchScan, makeScanFallback } from "@/app/scan-bus"
import { useShortcuts } from "@/app/shortcuts"
import { isScanField } from "@/app/focus-registry"
import { createWedgeListener } from "@/lib/scanning/wedge"
import { initials, logout, useStaff } from "@/lib/auth"
import { isDemo, isServerUnreachable, setSimulatedOffline } from "@/lib/api"
import { netSnapshot, subscribeNet } from "@/lib/offline/net"
import { OfflineStrip } from "@/lib/offline/OfflineStrip"
import { ServerUnreachable } from "@/app/server-unreachable"

const NAV = [
  { to: "/counter/stock", label: "Stock" },
  { to: "/counter/trade", label: "Trade" },
  { to: "/counter/customers", label: "Customers" },
  { to: "/counter/reports", label: "Reports" },
] as const

const BAR = [
  { to: "/counter", label: "Home", exact: true, Icon: HouseIcon },
  { to: "/counter/scan", label: "Scan", exact: false, Icon: BarcodeGlyph },
  { to: "/counter/stock", label: "Stock", exact: false, Icon: LayersIcon },
  { to: "/counter/trade", label: "Trade", exact: false, Icon: ArrowLeftRightIcon },
] as const

function AvatarMenu() {
  const staff = useStaff()
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
          {staff?.role === "admin" ? (
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

function MoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

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
              { label: "Customers", to: "/counter/customers" },
              { label: "Reports", to: "/counter/reports" },
              { label: "Exports and imports", to: "/counter/exports" },
              { label: "Add stock", to: "/counter/stock/new" },
              { label: "My Vault", to: "/account" },
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
  const [dockSlot, setDockSlot] = React.useState<HTMLDivElement | null>(null)
  const dockRef = React.useRef<HTMLDivElement>(null)
  const demo = isDemo()

  const openPalette = React.useCallback(() => setPaletteOpen(true), [])
  useShortcuts(openPalette)

  React.useEffect(() => {
    const fallback = makeScanFallback(navigate)
    return createWedgeListener({
      onScan: (raw) => dispatchScan(raw, fallback),
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
  }, [])

  // A production build with no PocketBase behind it: nothing else on this
  // shell can be trusted, so show only the paper state and nothing more.
  if (isServerUnreachable()) {
    return <ServerUnreachable />
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
                </Link>
              </li>
            ))}
          </ul>
          {demo ? <Badge variant="outline">Demo</Badge> : null}
          <AvatarMenu />
        </nav>
      </header>

      {/* One hairline line, and only when the queue or the connection has
          something to say. */}
      <OfflineStrip />

      <main
        id="counter-main"
        className="mx-auto w-full max-w-[1040px] flex-1 px-5 pb-[calc(var(--gg-dock-h,5rem)+2.5rem)] sm:px-10 min-[900px]:pb-16"
      >
        <Outlet />
      </main>

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

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
      <IdleLock />
    </div>
    </CounterDockContext.Provider>
  )
}
