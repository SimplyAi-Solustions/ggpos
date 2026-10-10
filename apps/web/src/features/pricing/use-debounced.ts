import * as React from "react"

/**
 * A value once it has stopped changing for `delay` milliseconds.
 *
 * Every lookup field needs this rather than `useDeferredValue`: deferring
 * only lowers the priority of the render, so a keystroke still fires a
 * request, and a name lookup reaches the game's own adapter. 300ms is about
 * a typed word rather than a typed letter.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = React.useState(value)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return settled
}
