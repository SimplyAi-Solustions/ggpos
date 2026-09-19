import type { NavigateFn } from "@tanstack/react-router"

import { routeScannedCode, type ScanOutcome } from "@/lib/scanning/route-code"

/**
 * The wedge listener runs once, in the counter shell, so a scan works on any
 * screen. The Scan screen takes the handler over while it is mounted, because
 * it shows the error under its own field and keeps the recent list.
 */

type Handler = (raw: string) => void

let handler: Handler | null = null

export function setScanHandler(next: Handler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** Sends a scan to the screen that claimed it, or to the fallback. */
export function dispatchScan(raw: string, fallback: Handler) {
  ;(handler ?? fallback)(raw)
}

/**
 * Where a decoded code goes. Item SKUs and customer codes route straight
 * there; a retail barcode opens Add stock with the EAN filled in; anything
 * the app cannot place is handed to the Scan screen, which says so under the
 * field rather than in a toast.
 */
export function applyScanOutcome(
  outcome: ScanOutcome,
  navigate: NavigateFn,
  raw: string
) {
  switch (outcome.kind) {
    case "item":
      void navigate({ to: "/counter/stock/$sku", params: { sku: outcome.sku } })
      return
    case "customer":
      void navigate({
        to: "/counter/customers/$code",
        params: { code: outcome.code },
      })
      return
    case "ean":
      void navigate({ to: "/counter/stock/new", search: { ean: outcome.ean } })
      return
    default:
      void navigate({ to: "/counter/scan", search: { code: raw } })
  }
}

/** The shell's fallback: decode, then route. */
export function makeScanFallback(navigate: NavigateFn): Handler {
  return (raw: string) => applyScanOutcome(routeScannedCode(raw), navigate, raw)
}
