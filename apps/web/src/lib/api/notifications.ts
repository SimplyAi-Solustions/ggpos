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
import type { NotificationPage, NotificationRow } from "@/lib/api/types"

/**
 * The page, whichever wrapper the server used.
 *
 * `docs/api-contract.md` settles on `{ items, unread }`; an earlier draft
 * said `{ notifications }` and a bare array is what a plain collection read
 * would give. All three are read, and `unread` is counted from the rows
 * when the server does not send it, so the nav badge can never disagree
 * with the list under it.
 */
export function toNotificationPage(result: unknown): NotificationPage {
  const rows = Array.isArray(result)
    ? (result as NotificationRow[])
    : readRows((result ?? {}) as Record<string, unknown>)
  const body = (result ?? {}) as Record<string, unknown>
  const unread =
    !Array.isArray(result) && typeof body.unread === "number"
      ? body.unread
      : rows.filter((row) => !row.read_at).length
  return { items: rows, unread }
}

function readRows(body: Record<string, unknown>): NotificationRow[] {
  for (const key of ["items", "notifications", "rows"]) {
    const value = body[key]
    if (Array.isArray(value)) return value as NotificationRow[]
  }
  return []
}

export async function listMyNotifications(): Promise<NotificationPage> {
  if (isDemo()) return demoListNotifications()
  const result = await pbCustomer.send("/api/vault/me/notifications", {
    method: "GET",
  })
  return toNotificationPage(result)
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
