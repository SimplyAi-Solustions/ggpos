import * as React from "react"

import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  DEMO_PORTAL_CUSTOMER_ID,
  setDemoPortalCustomer,
} from "@/lib/api/demo/portal-seed"

/**
 * The My Vault session, kept apart from the counter's.
 *
 * Live: the portal's own PocketBase client owns the token, persisted under
 * `gg_customer_auth`, so signing in here never evicts a staff session under
 * `pocketbase_auth` and signing out at the counter never signs a customer out.
 * That store keeps the token and nothing else (`lib/pb-customer.ts`), so the
 * name, email and code a `LocalAuthStore` would have written beside it are
 * never in a browser store at all; `GET /me` fetches them back.
 *
 * Demo: the same shape in localStorage under `gg-demo-customer`, holding the
 * record id and nothing else. No name, no email, no code.
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
  const asked = demoSessionFromUrl()
  if (asked) return asked
  try {
    return localStorage.getItem(DEMO_SESSION_KEY)
  } catch {
    return null
  }
}

/**
 * `?demo_as=<demo customer id>`: a signed-in demo session from a URL alone.
 *
 * Demo mode only, and demo mode itself is now a dev server or a build made
 * with `VITE_DEMO_SWITCH=1` (`lib/api/mode.ts`), so this cannot exist in a
 * shop's own build. It is what lets the screenshot script and the Impeccable
 * detector open a signed-in portal route by address, without a script
 * reaching into localStorage first, and it never invents a customer: the id
 * has to be one the demo shop already holds or its screens read as empty.
 */
function demoSessionFromUrl(): string | null {
  try {
    const asked = new URLSearchParams(window.location.search).get("demo_as")
    return asked && /^[a-z0-9_]{1,40}$/i.test(asked) ? asked : null
  } catch {
    return null
  }
}

function recompute(): string | null {
  if (isDemo()) {
    const id = readDemoSession()
    // A reload has to put the demo shop back on whichever card signed in,
    // which is the one thing the stored id is for.
    if (id) setDemoPortalCustomer(id)
    snapshot = id
  } else {
    snapshot = customerAuthId()
  }
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
export function rememberDemoSession(customerId = DEMO_PORTAL_CUSTOMER_ID) {
  setDemoPortalCustomer(customerId)
  try {
    localStorage.setItem(DEMO_SESSION_KEY, customerId)
  } catch {
    // Private browsing: the session lives for this page load only.
  }
  emit()
}

export function signOut() {
  if (isDemo()) {
    setDemoPortalCustomer(DEMO_PORTAL_CUSTOMER_ID)
    try {
      localStorage.removeItem(DEMO_SESSION_KEY)
    } catch {
      // Nothing to clear.
    }
    emit()
    return
  }
  // Only this client's own store: the counter's `pocketbase_auth` is a
  // different store on a different client and is never touched here.
  pbCustomer.authStore.clear()
}
