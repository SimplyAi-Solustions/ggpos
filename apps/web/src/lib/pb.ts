import PocketBase from "pocketbase"

/**
 * One PocketBase client for the whole app.
 *
 * In production PocketBase serves the built PWA from `pb_public`, so the app
 * and the API share an origin and the base URL is just "/". In dev the Vite
 * server proxies `/api` and `/_` to 127.0.0.1:8091 (see vite.config.ts), so
 * the same "/" works there too. `VITE_PB_URL` overrides it when the app is
 * served from somewhere else.
 *
 * The SDK persists its auth store in localStorage under `pocketbase_auth`,
 * so a counter PC stays signed in across a reload.
 */
export const pb = new PocketBase(import.meta.env.VITE_PB_URL ?? "/")

/** Turned off: a counter screen refreshes through TanStack Query, not on focus. */
pb.autoCancellation(false)

/** Does the live server answer? Used once at boot to decide on demo mode. */
export async function pingPocketBase(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(pb.buildURL("/api/health"), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
