/**
 * The PIN step's arithmetic and its refusals, kept pure so they can be
 * tested without a keypad on screen.
 *
 * `applyKey` in `components/ui/keypad.tsx` drops leading zeros, which is
 * right for pence and wrong for a PIN: "0258" is a PIN and "258" is not.
 * So the lock keeps its own, which only ever appends a digit, drops one or
 * clears.
 */
import { ClientResponseError } from "pocketbase"

import type { KeypadKey } from "@/components/ui/keypad"

/** The next PIN after a key press, never longer than the PIN being entered. */
export function pressPinKey(value: string, key: KeypadKey, length: number): string {
  if (key === "clear") return ""
  if (key === "back") return value.slice(0, -1)
  if (!/^\d$/.test(key)) return value
  if (value.length >= length) return value
  return value + key
}

export type RefusalKind =
  /** A wrong PIN: the dots clear and the person tries again. */
  | "wrong"
  /** Five wrong PINs: the PIN is locked until a password sign-in or an admin clears it. */
  | "locked"
  /** The person has no PIN to enter. */
  | "no_pin"
  /** Inactive, or not allowed to approve this. */
  | "refused"
  /** This browser is no longer a registered till. */
  | "device"
  /** No answer at all. */
  | "network"
  | "other"

export interface Refusal {
  kind: RefusalKind
  message: string
}

export const NO_ANSWER =
  "The till could not reach the server. Check the connection and try again."

export const NOT_A_TILL =
  "This device is not registered as a till. Sign in with a password and register it under Settings."

/**
 * What an unlock or an approval refusal means, and the sentence to show:
 * always the server's own (docs/api-contract-epos.md, section 2), with a
 * fallback only when it sent none.
 */
export function readRefusal(error: unknown): Refusal {
  if (!(error instanceof ClientResponseError)) {
    return { kind: "network", message: NO_ANSWER }
  }
  if (error.status === 0) return { kind: "network", message: NO_ANSWER }
  const message = (error.response?.message as string | undefined)?.trim() || error.message?.trim() || ""
  switch (error.status) {
    case 401:
      // The device refusal and a wrong PIN share the status; only one of
      // them talks about the device.
      if (/device|registered/i.test(message)) return { kind: "device", message: NOT_A_TILL }
      return { kind: "wrong", message: message || "That PIN is not right. Try again." }
    case 423:
      return {
        kind: "locked",
        message:
          message ||
          "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN.",
      }
    case 409:
      return { kind: "no_pin", message: message || "There is no PIN to enter. Use your password." }
    case 403:
      return { kind: "refused", message: message || "That cannot be approved here." }
    default:
      return { kind: "other", message: message || NO_ANSWER }
  }
}
