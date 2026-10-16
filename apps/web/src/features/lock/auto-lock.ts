/**
 * The auto-lock timer: a set number of minutes without a key, a tap, a
 * wheel or a touch, and the counter locks itself.
 *
 * On a registered till the minutes are `settings.epos.auto_lock_minutes`
 * (five by default) and the lock is the PIN screen; on any other browser
 * it is the password lock after ten minutes, as it always was. Zero
 * minutes switches the timer off; the Lock key still works.
 */
import * as React from "react"

import { lockCounter } from "@/features/lock/lock-store"

const ACTIVITY = ["keydown", "pointerdown", "wheel", "touchstart"] as const

/** Ten minutes on a browser that is not a till, exactly as before the till. */
export const PASSWORD_LOCK_MINUTES = 10

/** Starts the countdown while `ms` is above zero, and restarts it on activity. */
export function useAutoLock(ms: number) {
  React.useEffect(() => {
    if (!(ms > 0)) return undefined
    let timer = window.setTimeout(lockCounter, ms)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(lockCounter, ms)
    }
    for (const event of ACTIVITY) {
      window.addEventListener(event, reset, { passive: true, capture: true })
    }
    return () => {
      window.clearTimeout(timer)
      for (const event of ACTIVITY) window.removeEventListener(event, reset, { capture: true })
    }
  }, [ms])
}
