/**
 * The service worker's runtime caches, named in one place.
 *
 * `vite.config.ts` names them when it writes the worker and this module
 * empties them, so the two cannot drift apart. They hold reads a counter
 * needs when the line drops: the pricing config, the stock list and the
 * customers' names and codes. That is other people's data on a shared
 * machine, so it does not outlive the session that fetched it: signing out
 * and the idle lock both clear it.
 */
export const RUNTIME_CACHES = {
  config: "gg-config",
  stock: "gg-stock",
  customers: "gg-customers",
} as const

export const RUNTIME_CACHE_NAMES: string[] = Object.values(RUNTIME_CACHES)

/**
 * Empty them. Safe to call anywhere: a browser with no Cache Storage, or one
 * that refuses (private browsing), simply has nothing to clear.
 */
export async function clearOfflineCaches(): Promise<void> {
  if (typeof caches === "undefined") return
  await Promise.all(
    RUNTIME_CACHE_NAMES.map((name) => caches.delete(name).catch(() => false))
  )
}
