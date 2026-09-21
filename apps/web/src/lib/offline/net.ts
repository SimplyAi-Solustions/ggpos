/**
 * Is the counter online?
 *
 * `navigator.onLine` is the browser's answer and it is often wrong the
 * optimistic way: a tethered phone with no signal still reports a
 * connection. So a failed request counts too. That flag has to be able to
 * clear itself again, because on a tether the browser never fires `online`:
 * while it is set, a cheap probe runs every thirty seconds, and any request
 * anywhere in the API layer that comes back clears it as well.
 *
 * Demo mode adds a third input, a switch in the avatar menu, so the offline
 * flow can be walked and tested without unplugging anything.
 */

type Listener = () => void

/** How often the probe asks, while a failure is latched. */
export const PROBE_INTERVAL_MS = 30_000

const listeners = new Set<Listener>()

let simulated = false
let failed = false
let snapshot = { offline: false, simulated: false }

/** Registered by `lib/api/offline.ts`: one cheap, unaudited GET. */
type Probe = () => Promise<unknown>
let probe: Probe | null = null
let timer: ReturnType<typeof setInterval> | null = null
let probing = false

function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

function recompute() {
  const offline = simulated || browserOffline() || failed
  if (offline === snapshot.offline && simulated === snapshot.simulated) return
  snapshot = { offline, simulated }
  for (const listener of listeners) listener()
}

function startProbe() {
  if (timer !== null || typeof window === "undefined") return
  timer = setInterval(() => void runNetProbe(), PROBE_INTERVAL_MS)
}

function stopProbe() {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * Ask the server whether it is there. Exported so a test can drive it
 * without waiting thirty seconds.
 */
export async function runNetProbe(): Promise<void> {
  if (probing || !failed || simulated || browserOffline() || !probe) return
  probing = true
  try {
    await probe()
    // It answered. Whatever it said, the line is up.
    noteNetworkSuccess()
  } catch {
    // Still nothing. The next tick tries again.
  } finally {
    probing = false
  }
}

export function registerNetProbe(next: Probe | null) {
  probe = next
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    // The browser says the link is back, so the last failure is old news.
    noteNetworkSuccess()
  })
  window.addEventListener("offline", () => recompute())
  snapshot = { offline: simulated || browserOffline(), simulated }
}

/** True when a write should be queued rather than sent. */
export function isOffline(): boolean {
  return simulated || browserOffline() || failed
}

/** Demo mode only: pretend the connection has gone. */
export function setSimulatedOffline(next: boolean) {
  simulated = next
  if (!next) failed = false
  stopProbe()
  recompute()
}

export function isSimulatedOffline(): boolean {
  return simulated
}

/** A request that never reached the server, as opposed to one it refused. */
export function noteNetworkFailure() {
  if (simulated || failed) return
  failed = true
  startProbe()
  recompute()
}

/** A request that did reach the server, whatever it answered. */
export function noteNetworkSuccess() {
  if (!failed) return
  failed = false
  stopProbe()
  recompute()
}

export function subscribeNet(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A stable object for `useSyncExternalStore`. */
export function netSnapshot(): { offline: boolean; simulated: boolean } {
  return snapshot
}

/** Tests only. */
export function resetNet() {
  simulated = false
  failed = false
  probe = null
  probing = false
  stopProbe()
  snapshot = { offline: browserOffline(), simulated: false }
}
