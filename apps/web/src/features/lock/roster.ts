/**
 * The words the lock screen and the approval dialog put beside a name.
 * Pure, so the tests read them without a screen.
 */
import { CAPABILITY_LABELS, type RosterEntry } from "@gg/shared"

import type { OverrideRequest } from "@/features/lock/override"

/** Both screens read the till's roster under this key, so one refresh moves both. */
export const ROSTER_KEY = ["till-roster"] as const

/** The first word of a name, for the tile and the PIN step's lines. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** Why a name cannot take a PIN, in the words the tile shows. */
export function pinNote(entry: Pick<RosterEntry, "pin_set" | "pin_locked">): string | null {
  if (entry.pin_locked) return "PIN locked"
  if (!entry.pin_set) return "No PIN"
  return null
}

/** What the approval dialog says it is approving, in a sentence. */
export function approvalLine(request: Pick<OverrideRequest, "capability" | "description">): string {
  return request.description.trim() || CAPABILITY_LABELS[request.capability]
}
