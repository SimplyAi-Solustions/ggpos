import * as React from "react"

/**
 * The phone dock.
 *
 * Below 900px the counter's primary action sits in the thumb zone, directly
 * on top of the tab bar. The two have to be one fixed group, or a strip of
 * the scrolling page shows through the gap between them, so the shell owns
 * the group and a screen portals its one block button into this slot.
 *
 * The shell also publishes the group's measured height as `--gg-dock-h`, so
 * the content column can reserve exactly the right amount of room and every
 * field scrolls clear of both bars.
 */
export const CounterDockContext = React.createContext<HTMLElement | null>(null)

/** The node to portal a docked primary action into, or null on a desktop. */
export function useCounterDock(): HTMLElement | null {
  return React.useContext(CounterDockContext)
}
