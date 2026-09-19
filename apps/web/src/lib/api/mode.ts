/**
 * Demo mode: the whole app runs off in-memory fixtures so it can be explored,
 * screenshotted and end-to-end tested without a PocketBase behind it.
 *
 * Three ways in, in this order:
 *  1. `VITE_DEMO=1` at build time, for a demo deployment.
 *  2. `?demo=1` on any URL, which sticks for the tab through sessionStorage,
 *     so a plain production build can be driven into demo mode by a test.
 *  3. PocketBase not answering `/api/health` at boot, which is what happens
 *     when `vite preview` serves the built app with no server behind it.
 */
import { pingPocketBase } from "@/lib/pb"

const STICKY_KEY = "gg-demo"

let resolved: boolean | null = null

function readSticky(): boolean {
  try {
    return sessionStorage.getItem(STICKY_KEY) === "1"
  } catch {
    return false
  }
}

function writeSticky() {
  try {
    sessionStorage.setItem(STICKY_KEY, "1")
  } catch {
    // Private browsing: demo mode still holds for this page load.
  }
}

/**
 * Decide once, before the first render, so no screen ever flips data source
 * underneath itself. Called from main.tsx.
 */
export async function resolveDataMode(): Promise<boolean> {
  if (import.meta.env.VITE_DEMO === "1") {
    resolved = true
    return true
  }

  const fromQuery = new URLSearchParams(window.location.search).get("demo") === "1"
  if (fromQuery) writeSticky()
  if (fromQuery || readSticky()) {
    resolved = true
    return true
  }

  const alive = await pingPocketBase()
  resolved = !alive
  if (resolved) writeSticky()
  return resolved
}

/** True when every call in `lib/api` is answered from fixtures. */
export function isDemo(): boolean {
  if (resolved === null) {
    // Nothing has resolved yet (a unit test, or an import before boot).
    return import.meta.env.VITE_DEMO === "1" || readSticky()
  }
  return resolved
}

/** Tests and the screenshot script set the mode directly. */
export function setDataMode(demo: boolean) {
  resolved = demo
}
