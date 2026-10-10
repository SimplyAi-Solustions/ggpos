import * as React from "react"

import { todayIso } from "@/lib/api/dates"

/**
 * Today, as a UTC day, kept right while the screen stays open.
 *
 * A counter PC is left on. A date frozen when the page mounted means the
 * presets, the date fields' own maximum and the day a drawer is compared
 * against all quietly belong to yesterday from midnight onwards, which is
 * exactly when the shop is least likely to notice. The tick is once a
 * minute and only sets state when the day has actually turned over, so it
 * costs nothing and re-renders nothing on an ordinary day.
 */
export function useToday(): string {
  const [today, setToday] = React.useState(todayIso)

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setToday((current) => {
        const now = todayIso()
        return now === current ? current : now
      })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return today
}
