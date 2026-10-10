/**
 * Demo mode: the whole app runs off in-memory fixtures so it can be explored,
 * screenshotted and end-to-end tested without a PocketBase behind it.
 *
 * Three ways in, in this order:
 *  1. `VITE_DEMO=1` at build time, for a demo deployment.
 *  2. `?demo=1` on any URL, which sticks for the tab through sessionStorage.
 *     The switch only exists in a dev server or in a build made with
 *     `VITE_DEMO_SWITCH=1` (the e2e and screenshot builds): a shop's own
 *     production build must never be drivable into fixtures by a query
 *     string somebody pastes into the address bar.
 *  3. In a Vite dev server only (`import.meta.env.DEV`), PocketBase not
 *     answering `/api/health` at boot, which is what happens when `pnpm dev`
 *     runs ahead of `pnpm pb`. A health-check failure is never written to
 *     sessionStorage, so the next boot always tries the real server again.
 *
 * A production build with none of the above, whose PocketBase does not
 * answer, is never switched to demo data: a counter that silently started
 * showing fixtures could make staff believe stock was saved when nothing was
 * persisted. It resolves to "unreachable" instead, and the counter shell and
 * the sign-in screen both show a plain paper state (`ServerUnreachable`)
 * rather than their usual content. See `decideMode` for the whole policy.
 */
import { pingPocketBase } from "@/lib/pb"

const STICKY_KEY = "gg-demo"

let resolved: boolean | null = null
let unreachable = false

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

export interface ModeInputs {
  /** `VITE_DEMO === "1"` at build time. */
  flag: boolean
  /** `?demo=1` on the current URL. Ignored unless `switchable`. */
  query: boolean
  /**
   * Whether this build honours `?demo=1` at all: a dev server, or a build
   * made with `VITE_DEMO_SWITCH=1`. A shop's production build does not.
   */
  switchable: boolean
  /** The sticky flag left by an earlier `?demo=1` visit this tab. */
  sticky: boolean
  /** A Vite dev server, never a built app: `import.meta.env.DEV`. */
  dev: boolean
  /** Did `/api/health` answer? Ignored once flag, query or sticky decide it. */
  alive: boolean
}

export interface ModeDecision {
  demo: boolean
  /** A production build with nothing to fall back on: show the paper state. */
  unreachable: boolean
  /** Whether this decision should be written to sessionStorage. */
  writeSticky: boolean
}

/**
 * The whole demo/live/unreachable policy in one pure function, so it can be
 * tested without a DOM, a network call or sessionStorage. `resolveDataMode`
 * below only gathers the inputs and applies the decision.
 */
export function decideMode({
  flag,
  query,
  switchable,
  sticky,
  dev,
  alive,
}: ModeInputs): ModeDecision {
  if (flag) return { demo: true, unreachable: false, writeSticky: false }
  // The query switch and the sticky flag it wrote are both gated: a build
  // that does not carry the switch cannot be pushed into demo data by a URL,
  // nor by a sessionStorage key somebody sets by hand.
  if (switchable && query) return { demo: true, unreachable: false, writeSticky: true }
  if (switchable && sticky) return { demo: true, unreachable: false, writeSticky: false }
  if (alive) return { demo: false, unreachable: false, writeSticky: false }
  // Not alive, and nothing asked for demo data. A dev server falls back to
  // fixtures, since PocketBase has most likely just not been started yet; a
  // production build never does, because that is a real counter that could
  // lose stock if it quietly carried on against fixtures instead.
  if (dev) return { demo: true, unreachable: false, writeSticky: false }
  return { demo: false, unreachable: true, writeSticky: false }
}

/**
 * Decide once, before the first render, so no screen ever flips data source
 * underneath itself. Called from main.tsx.
 */
export async function resolveDataMode(): Promise<boolean> {
  const flag = import.meta.env.VITE_DEMO === "1"
  const switchable = isSwitchable()
  const query =
    switchable && new URLSearchParams(window.location.search).get("demo") === "1"
  const sticky = switchable && readSticky()
  // Skip the network round trip once any of the above already decides it.
  const alive = flag || query || sticky ? true : await pingPocketBase()

  const decision = decideMode({
    flag,
    query,
    switchable,
    sticky,
    dev: import.meta.env.DEV,
    alive,
  })
  if (decision.writeSticky) writeSticky()
  resolved = decision.demo
  unreachable = decision.unreachable
  return resolved
}

/** True when every call in `lib/api` is answered from fixtures. */
export function isDemo(): boolean {
  if (resolved === null) {
    // Nothing has resolved yet (a unit test, or an import before boot).
    return import.meta.env.VITE_DEMO === "1" || (isSwitchable() && readSticky())
  }
  return resolved
}

/**
 * Does this build honour `?demo=1`?
 *
 * A Vite dev server always does, and so does a build made with
 * `VITE_DEMO_SWITCH=1`, which is how the e2e suite and the screenshot
 * scripts drive a real build into fixtures. A shop's production build is
 * made without it, so a query string cannot put a live counter or a real
 * customer's portal onto demo data.
 */
function isSwitchable(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_DEMO_SWITCH === "1"
}

/**
 * True when a production build could not reach PocketBase at boot and was
 * not told to use demo data. The counter shell and the sign-in screen show
 * `ServerUnreachable` instead of their usual content while this holds.
 */
export function isServerUnreachable(): boolean {
  return unreachable
}

/** Tests and the screenshot script set the mode directly. */
export function setDataMode(demo: boolean) {
  resolved = demo
  unreachable = false
}
