import { Layers, Menu, Package, ScanLine, Handshake, type LucideIcon } from "lucide-react"

export interface NavTab {
  to: "/scan" | "/deals" | "/stock" | "/cards" | "/more"
  label: string
  icon: LucideIcon
}

/** The five tabs, in order. Scan is first because it is the counter's front door. */
export const NAV_TABS: readonly NavTab[] = [
  { to: "/scan", label: "Scan", icon: ScanLine },
  { to: "/deals", label: "Deals", icon: Handshake },
  { to: "/stock", label: "Stock", icon: Package },
  { to: "/cards", label: "Cards", icon: Layers },
  { to: "/more", label: "More", icon: Menu },
]
