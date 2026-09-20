/**
 * Web push for My Vault.
 *
 * The browser owns the permission and the subscription; the shop only ever
 * holds the endpoint and its two keys, which `POST /api/vault/push/subscribe`
 * stores against the customer. Nothing personal goes into the subscription,
 * and the notification payload is written by the server, not by this file.
 *
 * Every step is guarded: an iOS browser with no `PushManager`, a customer who
 * says no, a shop that has not set a VAPID key up and a service worker that
 * has not registered yet all end in a plain sentence rather than an exception.
 */
import {
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/api/notifications"

export type PushState =
  /** The browser cannot do push at all. */
  | "unsupported"
  /** The shop has not set a key up yet. */
  | "unconfigured"
  /** Supported, not subscribed. */
  | "off"
  /** Subscribed on this device. */
  | "on"
  /** The customer said no; only the browser can undo it. */
  | "blocked"

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

/** The VAPID key arrives as base64url; `subscribe` wants raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const normal = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(normal)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }
  return bytes
}

function keyToBase64(subscription: PushSubscription, name: "p256dh" | "auth"): string {
  const key = subscription.getKey(name)
  if (!key) return ""
  const bytes = new Uint8Array(key)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null
  try {
    return await navigator.serviceWorker.ready
  } catch {
    return null
  }
}

/** What the Profile screen's push row should show right now. */
export async function pushState(vapidKey: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported"
  if (Notification.permission === "denied") return "blocked"
  if (!vapidKey) return "unconfigured"
  const registered = await registration()
  if (!registered) return "off"
  const existing = await registered.pushManager.getSubscription()
  return existing ? "on" : "off"
}

export class PushError extends Error {}

/** Asks for permission, subscribes, and tells the shop where to send. */
export async function enablePush(vapidKey: string): Promise<void> {
  if (!pushSupported()) {
    throw new PushError("This browser cannot show notifications. Try email instead.")
  }
  if (!vapidKey) {
    throw new PushError(
      "The shop has not turned push notifications on yet. Email still works."
    )
  }
  const permission = await Notification.requestPermission()
  if (permission !== "granted") {
    throw new PushError(
      "Notifications are turned off for this site. Turn them on in your browser settings."
    )
  }
  const registered = await registration()
  if (!registered) {
    throw new PushError("This page is not ready for notifications yet. Reload and try again.")
  }
  const subscription =
    (await registered.pushManager.getSubscription()) ??
    (await registered.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
    }))

  await subscribeToPush({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: keyToBase64(subscription, "p256dh"),
      auth: keyToBase64(subscription, "auth"),
    },
  })
}

/** Drops the subscription here and at the shop. */
export async function disablePush(): Promise<void> {
  const registered = await registration()
  if (!registered) return
  const subscription = await registered.pushManager.getSubscription()
  if (!subscription) return
  const { endpoint } = subscription
  await subscription.unsubscribe()
  await unsubscribeFromPush(endpoint)
}
