import PocketBase, { BaseAuthStore, getTokenPayload, type AuthRecord } from "pocketbase"

/**
 * The customer portal's own PocketBase client.
 *
 * My Vault and the counter can be open in the same browser: Richard signs in
 * at the till and then opens his own card, or a customer borrows the shop
 * tablet. The SDK keeps one token per auth store, so a single client would
 * have the second sign-in silently evict the first. This client therefore
 * carries its own store under `gg_customer_auth`, leaving the counter's
 * `pocketbase_auth` untouched, and vice versa.
 *
 * Same base URL as `lib/pb.ts`: PocketBase serves the built PWA in
 * production, and the Vite dev server proxies `/api` in development.
 */

const STORE_KEY = "gg_customer_auth"

/**
 * A store that persists the token and nothing else.
 *
 * `LocalAuthStore` writes the whole auth record beside the token, which for
 * a customer means their name, email, phone and code sitting in localStorage
 * on a device that might be the shop's own tablet. The token alone is enough
 * to be signed in; everything a screen shows comes back from `GET /me` on
 * the next read, so that is all this keeps. The record is still held in
 * memory for the life of the page, so the SDK behaves exactly as it does
 * with the stock store until a reload, after which `record` is null and
 * `/me` rehydrates it.
 */
class CustomerTokenStore extends BaseAuthStore {
  constructor() {
    super()
    const token = read()
    if (token) super.save(token, null)
  }

  save(token: string, record?: AuthRecord) {
    super.save(token, record)
    write(token)
  }

  clear() {
    super.clear()
    write("")
  }
}

function read(): string {
  try {
    return localStorage.getItem(STORE_KEY) ?? ""
  } catch {
    // Private browsing: the session lives for this page load only.
    return ""
  }
}

function write(token: string) {
  try {
    if (token) localStorage.setItem(STORE_KEY, token)
    else localStorage.removeItem(STORE_KEY)
  } catch {
    // Nothing to persist to; the in-memory store still works.
  }
}

export const pbCustomer = new PocketBase(
  import.meta.env.VITE_PB_URL ?? "/",
  new CustomerTokenStore()
)

/** A phone screen refreshes through TanStack Query, not on a stray abort. */
pbCustomer.autoCancellation(false)

/**
 * A token the server has stopped accepting is not a session.
 *
 * Erasing an account rotates the customer's `tokenKey`, and a token expires
 * on its own eventually, so a 401 from any portal call means this device is
 * signed out whether or not the store still holds something. Clearing it
 * here fires the store's own change event, which is what the session hook
 * and the `/account` guard listen to, so the next navigation lands on the
 * sign-in screen rather than on a screen that cannot load.
 */
pbCustomer.afterSend = (response, data) => {
  if (response.status === 401 && pbCustomer.authStore.token) {
    pbCustomer.authStore.clear()
  }
  return data
}

/** The signed-in customer's record id, or null. */
export function customerAuthId(): string | null {
  const store = pbCustomer.authStore
  if (!store.isValid) return null
  const record = store.record
  if (record) {
    // The store is this client's own, but a token minted for `staff` would
    // still be a valid token: My Vault is only ever a `customers` session.
    return record.collectionName === "customers" ? record.id : null
  }
  // After a reload the record has not been fetched back yet, so the id comes
  // off the token itself. Only the portal's own sign-in ever writes here.
  try {
    const id = getTokenPayload(store.token).id
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}
