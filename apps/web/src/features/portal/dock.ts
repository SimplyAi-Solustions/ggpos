import * as React from "react"

/**
 * My Vault's phone dock.
 *
 * Below 900px the screen's one block button sits in the thumb zone, directly
 * on top of the tab bar. The two have to be one fixed group or a strip of the
 * scrolling page shows between them, so the shell owns the group and a screen
 * portals its button into this slot. The shell also publishes the group's
 * measured height as `--gg-portal-dock-h`, so the column reserves exactly the
 * room it needs.
 */
export const PortalDockContext = React.createContext<HTMLElement | null>(null)

/** The node to portal a docked primary action into, or null on a desktop. */
export function usePortalDock(): HTMLElement | null {
  return React.useContext(PortalDockContext)
}
