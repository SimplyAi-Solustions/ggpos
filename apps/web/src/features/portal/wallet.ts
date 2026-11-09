import { pbCustomer } from "@/lib/pb-customer"

/**
 * The wallet API. The balance is a mirror of the till (Epos Now), written
 * by the shop, never computed here. The token is opaque and short-lived;
 * what is in it is the server's business.
 */
export interface WalletBalance {
  /** GBP pence, or null when the shop has not mirrored a balance yet. */
  balance_minor: number | null
  balance_at: string
  /** True when the mirror is missing or more than a day old. */
  stale: boolean
}

export function getWallet(): Promise<WalletBalance> {
  return pbCustomer.send<WalletBalance>("/api/vault/wallet", {})
}

export function getWalletToken(): Promise<{ token: string; ttl: number }> {
  return pbCustomer.send<{ token: string; ttl: number }>("/api/vault/wallet/token", { method: "POST" })
}
