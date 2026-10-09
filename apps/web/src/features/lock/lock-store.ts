/**
 * Whether the counter is locked, shared by the till's Lock key and the lock
 * screen (docs/EPOS-PLAN.md, "Staff, roles and PIN").
 *
 * STUB, grown by the lock package: today `lockCounter()` only flips the
 * flag. The lock screen mounted in the counter shell reads `useCounterLocked`
 * and shows itself; whatever unlocks calls `unlockCounter()`. The ticket on
 * the till lives in its own store, so locking never touches it.
 */
import * as React from "react"

let locked = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Lock now: the Lock key, or the auto-lock timer. */
export function lockCounter(): void {
  if (locked) return
  locked = true
  emit()
}

export function unlockCounter(): void {
  if (!locked) return
  locked = false
  emit()
}

export function isCounterLocked(): boolean {
  return locked
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCounterLocked(): boolean {
  return React.useSyncExternalStore(subscribe, isCounterLocked, () => false)
}
