import PocketBase, { LocalAuthStore } from "pocketbase"

/**
 * The customer portal's own PocketBase client.
 *
 * My Vault and the counter can be open in the same browser: Richard signs in
 * at the till and then opens his own card, or a customer borrows the shop
 * tablet. The SDK keeps one token per auth store, so a single client would
 * have the second sign-in silently evict the first. This client therefore
 * carries its own `LocalAuthStore` under `gg_customer_auth`, leaving the
 * counter's `pocketbase_auth` untouched, and vice versa.
 *
 * Same base URL as `lib/pb.ts`: PocketBase serves the built PWA in
 * production, and the Vite dev server proxies `/api` in development.
 */
export const pbCustomer = new PocketBase(
  import.meta.env.VITE_PB_URL ?? "/",
  new LocalAuthStore("gg_customer_auth")
)

/** A phone screen refreshes through TanStack Query, not on a stray abort. */
pbCustomer.autoCancellation(false)

/** The signed-in customer's record id, or null. */
export function customerAuthId(): string | null {
  const record = pbCustomer.authStore.record
  if (!record || !pbCustomer.authStore.isValid) return null
  // The store is this client's own, but a token minted for `staff` would
  // still be a valid token: My Vault is only ever a `customers` session.
  if (record.collectionName !== "customers") return null
  return record.id
}
