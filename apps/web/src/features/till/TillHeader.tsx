/**
 * The till's own 64px header (DESIGN.md, section 10, "Frame"): the G mark
 * back to Home, the register and whether its session is open, then the
 * parked tickets, who is signed in, the Lock key and the menu for cashing
 * up. The counter shell draws nothing around the till, so this is the
 * whole of its chrome.
 */
import { Link, useNavigate } from "@tanstack/react-router"
import { ClipboardListIcon, LockIcon, MenuIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuPrimitive,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { GMark } from "@/components/ui/wordmark"
import { lockCounter } from "@/features/lock/lock-store"
import { initials, useStaff } from "@/lib/auth"

/**
 * Where the menu goes. The cashing-up screen reads `?action=` and opens that
 * step, so every till job that is not selling is one tap from here.
 */
const CASH_ACTIONS = [
  { label: "X report", action: "x" },
  { label: "Cash up", action: "z" },
  { label: "No sale", action: "no_sale" },
  { label: "Paid in or out", action: "paid_in_out" },
] as const

function openedAt(iso: string | undefined): string {
  if (!iso) return ""
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

export function TillHeader({
  registerName,
  openedSince,
  closed,
  parked,
  onRecall,
  onReturns,
}: {
  registerName: string
  /** ISO time the session opened. */
  openedSince?: string
  closed: boolean
  parked: number
  onRecall: () => void
  onReturns: () => void
}) {
  const staff = useStaff()
  const navigate = useNavigate()
  const go = (href: string) => void navigate({ href })

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-hairline-soft px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/counter"
          aria-label="Back to the counter"
          className="flex size-14 shrink-0 items-center justify-center rounded-[var(--radius)] outline-none"
        >
          <GMark className="h-6" title="GG Vault" />
        </Link>
        <span className="flex min-w-0 flex-col gap-1" data-testid="till-register">
          <MicroLabel tone="ink" className="truncate">
            {registerName}
          </MicroLabel>
          <MicroLabel className="truncate">
            {closed ? (
              "Closed"
            ) : openedSince ? (
              <>
                Open <span className="max-sm:hidden">since </span>
                {openedAt(openedSince)}
              </>
            ) : (
              "Open"
            )}
          </MicroLabel>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Button
          variant="text"
          className="min-h-14 px-2"
          data-testid="till-parked"
          onClick={onRecall}
        >
          <span className="sr-only">Parked tickets: </span>
          <ClipboardListIcon aria-hidden="true" className="sm:hidden" />
          <span aria-hidden="true" className="max-sm:hidden">
            Parked
          </span>
          <span className="tnum">{parked}</span>
        </Button>
        <Avatar className="max-sm:hidden" title={staff ? `Signed in as ${staff.name}` : undefined}>
          <AvatarFallback>{initials(staff?.name ?? "")}</AvatarFallback>
        </Avatar>
        <Button
          variant="ghost-icon"
          className="size-14"
          aria-label="Lock the till"
          data-testid="till-lock"
          onClick={() => lockCounter()}
        >
          <LockIcon />
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost-icon" className="size-14" aria-label="Till menu" />
            }
          >
            <MenuIcon />
          </MenuTrigger>
          <MenuContent className="min-w-60">
            <MenuPrimitive.Group>
              {CASH_ACTIONS.map((entry) => (
                <MenuItem
                  key={entry.action}
                  className="min-h-14"
                  onClick={() => go(`/counter/cash?action=${entry.action}`)}
                >
                  {entry.label}
                </MenuItem>
              ))}
              <MenuItem className="min-h-14" onClick={onReturns}>
                Returns
              </MenuItem>
              <MenuItem className="min-h-14" onClick={() => go("/counter/cash")}>
                Reports
              </MenuItem>
            </MenuPrimitive.Group>
            <MenuSeparator />
            <MenuItem className="min-h-14" onClick={() => go("/counter")}>
              Back to the counter
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  )
}
