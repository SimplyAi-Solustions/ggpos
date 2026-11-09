import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { Activity, Boxes, FileUp, Printer, SlidersHorizontal } from "lucide-react"

import { cn } from "@/lib/cn"

const LINKS = [
  { to: "/stock", label: "Inventory", icon: Boxes },
  { to: "/stock/labels", label: "Labels", icon: Printer },
  { to: "/stock/health", label: "Health", icon: Activity },
  { to: "/stock/pricing", label: "Pricing", icon: SlidersHorizontal },
  { to: "/stock/import", label: "Import", icon: FileUp },
] as const

/** The Stock section's own sub-navigation, a scrollable pill row. */
export function StockNav() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const current = React.useRef<HTMLAnchorElement>(null)
  // The row scrolls sideways on a phone; keep the current section in view.
  React.useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [path])
  return (
    <nav aria-label="Stock sections" className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
      <ul className="flex w-max gap-2">
        {LINKS.map(({ to, label, icon: Icon }) => {
          const active = to === "/stock" ? path === "/stock" || path === "/stock/" : path.startsWith(to)
          return (
            <li key={to}>
              <Link
                ref={active ? current : undefined}
                to={to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors duration-200 [&_svg]:size-4",
                  active
                    ? "border-transparent bg-ink text-paper dark:bg-paper dark:text-ink"
                    : "border-line-2 bg-panel-2 text-fg-2 hover:text-fg"
                )}
              >
                <Icon aria-hidden />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
