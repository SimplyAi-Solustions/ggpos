/**
 * Whether the till is open, and on which register (docs/api-contract-epos.md,
 * section 3, `GET /api/vault/till/current`).
 *
 * Shared by the till screen (which will not take a sale while the till is
 * closed, and shows "Open since 09:02" in its header) and by cashing up
 * (which opens and closes it). Both read it under `TILL_CURRENT_KEY`, so
 * opening the till on one screen updates the other.
 */
import { useQuery } from "@tanstack/react-query"
import type { TillCurrent } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { getDemoTillCurrent } from "@/lib/api/demo/till-session"
import { getTillDevice } from "@/lib/till-device"

export const TILL_CURRENT_KEY = ["till-current"] as const

/**
 * The register this browser works on: its registration's, or none, which
 * the server reads as the default register.
 */
export function currentRegisterId(): string | undefined {
  return getTillDevice()?.register || undefined
}

export async function getTillCurrent(register = currentRegisterId()): Promise<TillCurrent> {
  if (isDemo()) return getDemoTillCurrent()
  return pb.send<TillCurrent>("/api/vault/till/current", {
    method: "GET",
    query: register ? { register } : {},
  })
}

/** The till's state for this browser's register, refreshed every half minute. */
export function useTillCurrent() {
  return useQuery({
    queryKey: [...TILL_CURRENT_KEY, currentRegisterId() ?? "default"],
    queryFn: () => getTillCurrent(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}
