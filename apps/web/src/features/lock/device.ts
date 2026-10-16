/**
 * This browser's till registration, as the lock reads it.
 *
 * Live, that is `lib/till-device.ts`: the device id and secret a manager's
 * registration left in localStorage. In demo mode the browser is treated as
 * a registered till from the start, so the PIN lock and manager approval can
 * be walked with no server, but that registration lives in the demo's own
 * sessionStorage key (`lib/api/demo/till-session.ts`) and never in the real
 * one: a demo tab must not leave a made-up device behind for a live counter
 * on the same browser to send.
 */
import * as React from "react"

import { isDemo } from "@/lib/api/mode"
import {
  getDemoThisDevice,
  setDemoThisDevice,
  subscribeDemoThisDevice,
} from "@/lib/api/demo/till-session"
import {
  clearTillDevice,
  getTillDevice,
  setTillDevice,
  useTillDevice,
  type StoredTillDevice,
} from "@/lib/till-device"

/** The registration in force: the demo's in demo mode, the real one otherwise. */
export function getLockDevice(): StoredTillDevice | null {
  return isDemo() ? getDemoThisDevice() : getTillDevice()
}

/** The same, kept current: a registration, a revoke or a forget re-renders. */
export function useLockDevice(): StoredTillDevice | null {
  const live = useTillDevice()
  const demo = React.useSyncExternalStore(subscribeDemoThisDevice, getDemoThisDevice, () => null)
  return isDemo() ? demo : live
}

/** Keep what the registration route handed back once. */
export function rememberDevice(device: StoredTillDevice): void {
  if (isDemo()) setDemoThisDevice(device)
  else setTillDevice(device)
}

/** Forget this browser's copy. The device row stays until a manager revokes it. */
export function forgetDevice(): void {
  if (isDemo()) setDemoThisDevice(null)
  else clearTillDevice()
}
