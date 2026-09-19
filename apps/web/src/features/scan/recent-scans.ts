import * as React from "react"

/**
 * The last ten things scanned at this counter, in memory only. It is a way
 * back to the item you just looked at, not a record: the audit log is the
 * record, and nothing here is written anywhere.
 */

export interface RecentScan {
  /** What the scanner or the keyboard produced. */
  raw: string
  /** How it reads on a label, when it is a GG code. */
  display: string
  /** One word for what it turned out to be. */
  kind: "Item" | "Customer" | "Voucher" | "Barcode" | "Not recognised"
  /** Where it went, when it went anywhere. */
  href?: string
  at: number
}

const LIMIT = 10

let scans: RecentScan[] = []
const listeners = new Set<() => void>()

export function recordScan(scan: Omit<RecentScan, "at">) {
  scans = [{ ...scan, at: Date.now() }, ...scans].slice(0, LIMIT)
  for (const listener of listeners) listener()
}

export function clearRecentScans() {
  scans = []
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const EMPTY: RecentScan[] = []

export function useRecentScans(): RecentScan[] {
  return React.useSyncExternalStore(
    subscribe,
    () => scans,
    () => EMPTY
  )
}
