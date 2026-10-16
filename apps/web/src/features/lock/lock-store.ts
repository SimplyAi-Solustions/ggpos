/**
 * Whether the counter is locked, shared by the till's Lock key, the
 * auto-lock timer and the lock screen (docs/EPOS-PLAN.md, "Staff, roles and
 * PIN").
 *
 * The flag is kept in localStorage, not in React state, for two reasons. A
 * reload of a locked till has to come back locked: a lock that a refresh
 * undoes is no lock on a shared counter. And the Mac and a second tab on the
 * same browser are the same till, so locking one locks the other (the
 * `storage` event carries it across).
 *
 * The flag names who was signed in when it was set, and only holds while
 * that person still is. Unlocking with a PIN or a password clears it
 * outright; a fresh password sign-in at `/login` by somebody else is a full
 * sign-in in its own right and is not held behind the last person's lock.
 *
 * Locking also drops what must not outlive a session left at the counter:
 * the step-up confirmation (whoever unlocks confirms again before a refund
 * or an ID photo) and the service worker's read-through caches of stock and
 * customer names. The till's ticket lives in its own store and is never
 * touched, so switching user keeps it exactly as it was.
 */
import * as React from "react"

import { currentStaff } from "@/lib/auth"
import { clearStepUp } from "@/lib/auth-stepup"
import { clearOfflineCaches } from "@/lib/offline/caches"

const STORAGE_KEY = "gg.counter.locked"

interface Stored {
  /** The staff id signed in when the counter locked. */
  staff: string
  at: string
}

const listeners = new Set<() => void>()
let cache: { raw: string | null; value: Stored | null } | null = null

function readStored(): Stored | null {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = memory
  }
  if (cache && cache.raw === raw) return cache.value
  let value: Stored | null = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Stored>
      if (typeof parsed.staff === "string") {
        value = { staff: parsed.staff, at: typeof parsed.at === "string" ? parsed.at : "" }
      }
    } catch {
      value = null
    }
  }
  cache = { raw, value }
  return value
}

/** Where the flag lives when localStorage is refused (a private window). */
let memory: string | null = null

function writeStored(value: Stored | null) {
  const raw = value ? JSON.stringify(value) : null
  memory = raw
  try {
    if (raw) window.localStorage.setItem(STORAGE_KEY, raw)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Kept in memory instead, for this page load.
  }
  cache = null
}

function emit() {
  for (const listener of listeners) listener()
}

/** Lock now: the Lock key, the account menu, or the auto-lock timer. */
export function lockCounter(): void {
  clearStepUp()
  void clearOfflineCaches()
  if (isCounterLocked()) return
  writeStored({ staff: currentStaff()?.id ?? "", at: new Date().toISOString() })
  emit()
}

/** Whoever unlocked it, with a PIN or a password, calls this. */
export function unlockCounter(): void {
  if (!readStored()) return
  writeStored(null)
  emit()
}

export function isCounterLocked(): boolean {
  const stored = readStored()
  if (!stored) return false
  const staff = currentStaff()
  // Nobody signed in: there is no counter to show, locked or not.
  if (!staff) return true
  return stored.staff === "" || stored.staff === staff.id
}

/** For code outside React that has to hear the counter lock. */
export function subscribeLock(listener: () => void): () => void {
  return subscribe(listener)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function useCounterLocked(): boolean {
  return React.useSyncExternalStore(subscribe, isCounterLocked, () => false)
}
