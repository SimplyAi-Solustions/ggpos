/**
 * The customer's notifications, and the push subscription behind them.
 *
 * Reading and marking read are the two Phase 5 routes; the subscribe and
 * unsubscribe pair takes either a customer or a staff token, and the portal
 * only ever sends a customer one.
 *
 * The counter's own side of notifications, which is what an admin is shown
 * about how they go out, is in its own section below.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoListNotifications,
  demoMarkNotificationRead,
} from "@/lib/api/demo/portal"
import type { NotificationRow, VaultConfig } from "@/lib/api/types"

export async function listMyNotifications(): Promise<NotificationRow[]> {
  if (isDemo()) return demoListNotifications()
  // A page envelope and a bare array are both accepted: the route list says
  // "newest first, 50" without naming the wrapper.
  const result = await pbCustomer.send<NotificationRow[] | { items?: NotificationRow[] }>(
    "/api/vault/me/notifications",
    { method: "GET" }
  )
  return Array.isArray(result) ? result : (result.items ?? [])
}

export async function markNotificationRead(id: string): Promise<void> {
  if (isDemo()) {
    demoMarkNotificationRead(id)
    return
  }
  await pbCustomer.send(`/api/vault/me/notifications/${id}/read`, { method: "POST" })
}

export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export async function subscribeToPush(body: PushSubscriptionBody): Promise<void> {
  if (isDemo()) return
  await pbCustomer.send("/api/vault/push/subscribe", { method: "POST", body })
}

export async function unsubscribeFromPush(endpoint: string): Promise<void> {
  if (isDemo()) return
  await pbCustomer.send("/api/vault/push/subscribe", {
    method: "DELETE",
    body: { endpoint },
  })
}

// ---------------------------------------------------------------------------
// What the counter shows about how notifications go out
//
// Admin-facing and read-only: the Settings screen says whether email is
// really being sent, which provider carries it, and whether push has a key
// yet. No key, secret or address is read here. The mail API key and the
// private half of the VAPID pair never leave the server at all.
// ---------------------------------------------------------------------------

/** The provider names, as an admin would say them. */
export const EMAIL_PROVIDER_LABEL: Record<string, string> = {
  resend: "Resend",
  postmark: "Postmark",
  brevo: "Brevo",
  none: "None",
}

/**
 * The public half of the VAPID pair, from `GET /api/vault/config`.
 *
 * Empty until the deploy sets one, which is what the Settings screen says in
 * words. It is public by design: every browser that subscribes is handed it.
 */
export function pushPublicKeyFrom(config: VaultConfig | undefined): string {
  return config?.push?.vapid_public_key ?? ""
}

/**
 * Is email really going out, or only being logged?
 *
 * The server treats anything but an explicit `false` as test mode, so a
 * half-filled settings row can never start emailing customers. The screen
 * reads it the same way rather than guessing the other way.
 */
export function emailTestModeFrom(
  settings: { email?: { test_mode?: boolean } } | undefined
): boolean {
  return settings?.email?.test_mode === false ? false : true
}
