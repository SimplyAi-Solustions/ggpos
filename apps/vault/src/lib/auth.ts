import * as React from "react"
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"

/**
 * The staff session, copied in approach from apps/web/src/lib/auth.ts: the
 * PocketBase SDK owns the token (localStorage `pocketbase_auth`), and this
 * module turns it into a small `Staff` snapshot React can subscribe to.
 *
 * Only a `staff` record counts. The customer pages share the auth store, and
 * a deactivated staff member's cached token is dropped on sight.
 */

export type StaffRole = "admin" | "manager" | "staff"

export interface Staff {
  id: string
  email: string
  name: string
  role: StaffRole
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SignInError"
  }
}

let snapshot: Staff | null = null
let primed = false
const listeners = new Set<() => void>()

/** Exported for tests; everything else uses `currentStaff` or `useStaff`. */
export function readSession(): Staff | null {
  const record = pb.authStore.record
  if (!record || !pb.authStore.isValid) return null
  if (record.collectionName !== "staff") return null
  if (record.active === false) {
    pb.authStore.clear()
    return null
  }
  return {
    id: record.id,
    email: String(record.email ?? ""),
    name: String(record.name ?? ""),
    // Anything the server did not name is the least role, never more.
    role: record.role === "admin" || record.role === "manager" ? record.role : "staff",
  }
}

function recompute(): Staff | null {
  const next = readSession()
  if ((next === null) !== (snapshot === null) || (next && snapshot && next.id !== snapshot.id)) {
    snapshot = next
  }
  primed = true
  return snapshot
}

pb.authStore.onChange(() => {
  recompute()
  for (const listener of listeners) listener()
}, false)

/** The signed-in staff member, or null. Safe outside React (route guards). */
export function currentStaff(): Staff | null {
  return primed ? snapshot : recompute()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useStaff(): Staff | null {
  return React.useSyncExternalStore(subscribe, currentStaff, () => null)
}

export async function signIn(email: string, password: string): Promise<Staff> {
  try {
    await pb.collection("staff").authWithPassword(email.trim(), password)
  } catch (error) {
    if (error instanceof ClientResponseError) {
      if (error.status === 0) {
        throw new SignInError("Could not reach the server. Check the connection and try again.")
      }
      const serverMessage = error.message?.trim()
      // PocketBase's plain 400 is a wrong email or password. Anything else,
      // such as the 403 for a deactivated account, is shown as sent.
      const generic = error.status === 400 && !/inactive/i.test(serverMessage ?? "")
      throw new SignInError(
        generic || !serverMessage
          ? "That email and password do not match a staff account."
          : serverMessage
      )
    }
    throw error
  }
  const staff = recompute()
  if (!staff) {
    pb.authStore.clear()
    throw new SignInError("That account cannot sign in to the Vault.")
  }
  return staff
}

export function signOut() {
  pb.authStore.clear()
}

/** "Richard Green" becomes "RG"; a single name becomes its first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "GG"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}
