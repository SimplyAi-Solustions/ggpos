/**
 * After an update, a page that was opened on the build before can ask for one
 * of that build's screen files, which the update has removed. The server
 * answers with the app's own page instead and the browser refuses it ("text/html
 * is not a valid JavaScript MIME type"), so the screen never opens.
 *
 * Vite reports every failed screen import as `vite:preloadError`. Reloading
 * fetches the new build, which is what the person needs. A reload in the last
 * minute means reloading did not help, so the error is left to show rather
 * than reloading round and round.
 */

const KEY = "gg-stale-build-reload-at"
const WINDOW_MS = 60_000

type ReloadStore = Pick<Storage, "getItem" | "setItem">

/** Whether to reload now, recording the time when it says yes. */
export function claimStaleBuildReload(store: ReloadStore | null, now: number): boolean {
  let last: number
  try {
    last = Number(store?.getItem(KEY) ?? 0) || 0
  } catch {
    last = 0
  }
  if (last > 0 && now - last < WINDOW_MS) return false
  try {
    store?.setItem(KEY, String(now))
  } catch {
    // Storage refused (a private window, say): reload anyway. Without the
    // record a second failure in a row reloads again, which still beats a
    // screen that will not open.
  }
  return true
}

interface StaleBuildWindow {
  addEventListener(type: "vite:preloadError", listener: (event: Event) => void): void
  location: { reload(): void }
  sessionStorage?: Storage
}

/** Reload once when a screen's file from an older build fails to load. */
export function watchForStaleBuild(win: StaleBuildWindow = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    let store: ReloadStore | null
    try {
      store = win.sessionStorage ?? null
    } catch {
      store = null
    }
    if (!claimStaleBuildReload(store, Date.now())) return
    event.preventDefault()
    win.location.reload()
  })
}
