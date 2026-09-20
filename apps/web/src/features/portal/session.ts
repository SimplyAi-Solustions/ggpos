import * as React from "react"

import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import { DEMO_PORTAL_CUSTOMER_ID } from "@/lib/api/demo/portal-seed"

/**
 * The My Vault session, kept apart from the counter's.
 *
 * Live: the portal's own PocketBase client owns the token, persisted under
 * `gg_customer_auth`, so signing in here never evicts a staff session under
 * `pocketbase_auth` and signing out at the counter never signs a customer out.
 * Demo: the same shape in localStorage under `gg-demo-customer`, holding the
 * record id and nothing else. No name, no email, no code: nothing personal is
 * written to a browser store beyond the token itself.
 *
 * This module is imported by the `/account` guard, so it travels in the entry
 * bundle. It therefore pulls in nothing but the client, the mode flag and one
 * demo id; the portal's API modules and fixtures stay in the route chunks.
 */

const DEMO_SESSION_KEY = "gg-demo-customer"

let snapshot: string | null = null
let read = false
const listeners = new Set<() => void>()

function readDemoSession(): string | null {
  try {
    return localStorage.getItem(DEMO_SESSION_KEY)
  } catch {
    return null
  }
}

function recompute(): string | null {
  snapshot = isDemo() ? readDemoSession() : customerAuthId()
  read = true
  return snapshot
}

function emit() {
  recompute()
  for (const listener of listeners) listener()
}

pbCustomer.authStore.onChange(() => emit(), false)

/** The signed-in customer's record id, or null. Safe outside React. */
export function currentCustomerId(): string | null {
  if (!read) recompute()
  return snapshot
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Re-renders whenever the portal session changes, in either mode. */
export function useCustomerSession(): string | null {
  return React.useSyncExternalStore(subscribe, currentCustomerId, () => null)
}

/** Called by the sign-in screen once a demo code has been accepted. */
export function rememberDemoSession() {
  try {
    localStorage.setItem(DEMO_SESSION_KEY, DEMO_PORTAL_CUSTOMER_ID)
  } catch {
    // Private browsing: the session lives for this page load only.
  }
  emit()
}

export function signOut() {
  if (isDemo()) {
    try {
      localStorage.removeItem(DEMO_SESSION_KEY)
    } catch {
      // Nothing to clear.
    }
    emit()
    return
  }
  pbCustomer.authStore.clear()
}
