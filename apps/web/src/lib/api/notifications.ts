/**
 * The customer's notifications, and the push subscription behind them.
 *
 * Reading and marking read are the two Phase 5 routes; the subscribe and
 * unsubscribe pair takes either a customer or a staff token, and the portal
 * only ever sends a customer one.
 */
import { pbCustomer } from "@/lib/pb-customer"
import { isDemo } from "@/lib/api/mode"
import {
  demoListNotifications,
  demoMarkNotificationRead,
} from "@/lib/api/demo/portal"
import type { NotificationRow } from "@/lib/api/types"

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
