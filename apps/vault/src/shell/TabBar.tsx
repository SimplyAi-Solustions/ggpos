import { Link, useRouterState } from "@tanstack/react-router"
import { motion } from "motion/react"

import { cn } from "@/lib/cn"
import { NAV_TABS } from "@/shell/nav"

function isActive(pathname: string, to: string): boolean {
  if (to === "/more") return pathname === "/more" || pathname.startsWith("/settings")
  return pathname === to || pathname.startsWith(`${to}/`)
}

/** Phones: the bottom tab bar, above the home indicator. */
export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav
      aria-label="Main"
      className="glass fixed inset-x-0 bottom-0 z-40 border-t border-line pb-[var(--safe-bottom)] md:hidden"
    >
      <ul className="mx-auto flex h-[var(--tabbar-h)] max-w-lg items-stretch px-2">
        {NAV_TABS.map(({ to, label, icon: Icon }) => {
          const active = isActive(pathname, to)
          return (
            <li key={to} className="flex-1">
              <Link
                to={to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                  active ? "text-fg" : "text-fg-3 hover:text-fg-2"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="tab-indicator"
                    className="absolute top-1.5 h-8 w-14 rounded-full bg-volt dark:[box-shadow:var(--glow-volt)]"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    aria-hidden
                  />
                )}
                <Icon
                  className={cn("relative z-10 mt-0.5 size-[22px]", active && "text-on-volt")}
                  strokeWidth={active ? 2.4 : 2}
                  aria-hidden
                />
                <span className={cn("relative z-10 mt-1", active && "font-semibold")}>{label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** Tablet and desktop: the left rail. */
export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav
      aria-label="Main"
      className="glass fixed inset-y-0 left-0 z-40 hidden w-[88px] flex-col items-center border-r border-line pt-[calc(var(--safe-top)+16px)] pb-[calc(var(--safe-bottom)+16px)] md:flex lg:w-[220px] lg:items-stretch lg:px-3"
    >
      <ul className="mt-16 flex flex-col gap-1.5 lg:mt-20">
        {NAV_TABS.map(({ to, label, icon: Icon }) => {
          const active = isActive(pathname, to)
          return (
            <li key={to}>
              <Link
                to={to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-14 w-16 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition-colors lg:h-12 lg:w-full lg:flex-row lg:justify-start lg:gap-3 lg:px-4 lg:text-[15px]",
                  active ? "text-on-volt" : "text-fg-2 hover:bg-line hover:text-fg"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="rail-indicator"
                    className="absolute inset-0 rounded-md bg-volt dark:[box-shadow:var(--glow-volt)]"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    aria-hidden
                  />
                )}
                <Icon className="relative z-10 size-[22px]" strokeWidth={active ? 2.4 : 2} aria-hidden />
                <span className={cn("relative z-10", active && "font-semibold")}>{label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
