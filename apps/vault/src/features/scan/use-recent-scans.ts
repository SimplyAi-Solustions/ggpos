import * as React from "react"

import { clearRecentScans, readRecentScans, type RecentScan } from "./history"

/** Reads the device's recent scans once and keeps them in state. */
export function useRecentScans() {
  const [scans, setScans] = React.useState<RecentScan[]>(() => readRecentScans())
  const clear = React.useCallback(() => {
    clearRecentScans()
    setScans([])
  }, [])
  return { scans, setScans, clear }
}
