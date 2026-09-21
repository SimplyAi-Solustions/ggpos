import * as React from "react"

import { pb } from "@/lib/pb"
import { clearStepUp } from "@/lib/auth-stepup"
import { clearOfflineCaches } from "@/lib/offline/caches"
import {
  changeOwnPassword as apiChangeOwnPassword,
  isDemo,
  login as apiLogin,
  PasswordChangeError,
  verifyPassword as apiVerifyPassword,
  type StaffRecord,
} from "@/lib/api"

/**
 * The staff session.
 *
 * Live: the PocketBase SDK owns it, persisted in localStorage under
 * `pocketbase_auth`, so a counter PC stays signed in across a reload.
 * Demo: the same shape kept in localStorage under `gg-demo-staff`, so the
 * fixture app behaves exactly like the real one, guard and all.
 */

const DEMO_SESSION_KEY = "gg-demo-staff"

let snapshot: StaffRecord | null = null
const listeners = new Set<() => void>()

function readDemoSession(): StaffRecord | null {
  try {
    const raw = localStorage.getItem(DEMO_SESSION_KEY)
    return raw ? (JSON.parse(raw) as StaffRecord) : null
  } catch {
    return null
  }
}

/**
 * Exported for its unit tests only; every other caller goes through
 * `currentStaff` or `useStaff`.
 */
export function readLiveSession(): StaffRecord | null {
  const record = pb.authStore.record
  if (!record || !pb.authStore.isValid) return null
  // The auth store is shared with the customer portal's token, which is a
  // `customers` record; only `staff` may run the counter.
  if (record.collectionName !== "staff") return null
  if (record.active === false) {
    // A deactivated member's cached token is worthless: drop it so the next
    // read (and the `/counter` guard) treats them as signed out.
    pb.authStore.clear()
    return null
  }
  return {
    id: record.id,
    email: String(record.email ?? ""),
    name: String(record.name ?? ""),
    role: record.role === "admin" ? "admin" : "staff",
    active: true,
    // The flag travels on the record sign-in hands back, so a reload of a
    // still-valid session knows to lock the counter without asking the
    // server again.
    must_change_password: record.must_change_password === true,
  }
}

function recompute() {
  const next = isDemo() ? readDemoSession() : readLiveSession()
  const changed =
    (next === null) !== (snapshot === null) ||
    (next !== null &&
      snapshot !== null &&
      (next.id !== snapshot.id ||
        // The password gate turns on and off without the person changing,
        // so the flag is part of what makes a session different.
        next.must_change_password !== snapshot.must_change_password))
  if (changed) snapshot = next
  return snapshot
}

function emit() {
  recompute()
  for (const listener of listeners) listener()
}

// The SDK fires this on sign-in, sign-out and token refresh.
pb.authStore.onChange(() => emit(), false)

/** The signed-in staff member, or null. Safe to call outside React. */
export function currentStaff(): StaffRecord | null {
  if (snapshot === null) recompute()
  return snapshot
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Re-renders whenever the session changes, in either mode. */
export function useStaff(): StaffRecord | null {
  return React.useSyncExternalStore(subscribe, currentStaff, () => null)
}

export async function login(email: string, password: string): Promise<StaffRecord> {
  const staff = await apiLogin(email, password)
  if (isDemo()) {
    try {
      localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(staff))
    } catch {
      // Private browsing: the session lives for this page load only.
    }
    snapshot = staff
    emit()
  }
  return staff
}

export function logout() {
  // A step-up confirmation is good for ten minutes, and this counter is
  // shared: it must not outlive the session that earned it. Neither do the
  // service worker's read-through caches, which hold stock and customer
  // names fetched under this session.
  clearStepUp()
  void clearOfflineCaches()
  if (isDemo()) {
    try {
      localStorage.removeItem(DEMO_SESSION_KEY)
    } catch {
      // Nothing to clear.
    }
    snapshot = null
    emit()
    return
  }
  pb.authStore.clear()
}

/**
 * Sets a new password on the signed-in staff member's own account and
 * leaves them signed in with it.
 *
 * The change invalidates the token it was made with, so `lib/api` signs
 * straight back in and hands back the record as it is afterwards: in demo
 * mode that record is written to the demo session, and live it is already
 * in the SDK's auth store. Either way the gate in `features/auth/gate.ts`
 * sees an unlocked staff member on the next render.
 */
export async function changePassword(
  current: string,
  next: string
): Promise<StaffRecord> {
  const staff = currentStaff()
  // A `PasswordChangeError` and not a bare one: the screen shows those in
  // words under the field and turns anything else into "the counter could
  // not reach the server", which would send somebody to check the network
  // over a session that had simply ended.
  if (!staff) {
    throw new PasswordChangeError("Sign in again, then set your new password.")
  }
  const updated = await apiChangeOwnPassword(staff.email, current, next)
  if (isDemo()) {
    try {
      localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(updated))
    } catch {
      // Private browsing: the session lives for this page load only.
    }
  }
  snapshot = updated
  emit()
  return updated
}

/** Confirms the signed-in staff member's own password, for the idle lock. */
export async function confirmPassword(password: string): Promise<boolean> {
  const staff = currentStaff()
  if (!staff) return false
  return apiVerifyPassword(staff.email, password)
}

/** "Richard Green" becomes "RG"; a single name becomes its first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "GG"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}
