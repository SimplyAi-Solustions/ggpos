/**
 * This browser's registration as a till (docs/api-contract-epos.md,
 * section 2, "Devices").
 *
 * A manager registers a browser to a register once, with their password;
 * the server hands back a device id and a secret, shown once, which live
 * here in localStorage under "gg.till.device". Every device route (the
 * roster, PIN unlock, manager approval) sends them as
 * `X-GG-Device: <id>.<secret>`. A PIN on its own, from a browser without
 * this, opens nothing.
 *
 * Signing out does not clear it: the device stays a till until a manager
 * revokes it under Settings, or this browser's site data is cleared.
 */
import * as React from "react"
import type { TillDevice } from "@gg/shared"

const STORAGE_KEY = "gg.till.device"
export const DEVICE_HEADER = "X-GG-Device"

export interface StoredTillDevice extends TillDevice {
  secret: string
}

const listeners = new Set<() => void>()
let cached: StoredTillDevice | null | undefined

function read(): StoredTillDevice | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredTillDevice>
    if (
      typeof parsed.id === "string" &&
      typeof parsed.secret === "string" &&
      typeof parsed.register === "string" &&
      parsed.id &&
      parsed.secret
    ) {
      return {
        id: parsed.id,
        secret: parsed.secret,
        register: parsed.register,
        register_name: typeof parsed.register_name === "string" ? parsed.register_name : "",
        label: typeof parsed.label === "string" ? parsed.label : "",
      }
    }
    return null
  } catch {
    // Private windows and blocked site data throw; such a browser is simply
    // not a till.
    return null
  }
}

function emit() {
  for (const listener of listeners) listener()
}

/** This browser's till registration, or null. */
export function getTillDevice(): StoredTillDevice | null {
  if (cached === undefined) cached = read()
  return cached
}

/** Keep the registration the server returned once. */
export function setTillDevice(device: StoredTillDevice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(device))
  } catch {
    // Nothing to do: the device will ask to be registered again.
  }
  cached = device
  emit()
}

/** Forget the registration (revoked, or "Unregister this device"). */
export function clearTillDevice(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above.
  }
  cached = null
  emit()
}

/** The header device routes need, or an empty object on an unregistered browser. */
export function deviceHeaders(): Record<string, string> {
  const device = getTillDevice()
  return device ? { [DEVICE_HEADER]: `${device.id}.${device.secret}` } : {}
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cached = read()
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** The registration, kept current across tabs. */
export function useTillDevice(): StoredTillDevice | null {
  return React.useSyncExternalStore(subscribe, getTillDevice, () => null)
}
