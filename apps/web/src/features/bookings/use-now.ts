import * as React from "react"

/**
 * The time now, ticking every `everyMs`: a station's running clock and the
 * day view's "now" line move on their own while the screen is left open.
 */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}
