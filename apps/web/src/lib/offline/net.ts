/**
 * Is the counter online?
 *
 * `navigator.onLine` is the browser's answer and it is often wrong the
 * optimistic way: a tethered phone with no signal still reports a connection.
 * So a failed request counts too. Any request that gets through clears it
 * again, which is what the queue's replay does on its way past.
 *
 * Demo mode adds a third input, a switch in the avatar menu, so the offline
 * flow can be walked and tested without unplugging anything.
 */

type Listener = () => void

const listeners = new Set<Listener>()

let simulated = false
let failed = false
let snapshot = { offline: false, simulated: false }

function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

function recompute() {
  const offline = simulated || browserOffline() || failed
  if (offline === snapshot.offline && simulated === snapshot.simulated) return
  snapshot = { offline, simulated }
  for (const listener of listeners) listener()
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    // The browser says the link is back, so the last failure is old news.
    failed = false
    recompute()
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
  recompute()
}

export function isSimulatedOffline(): boolean {
  return simulated
}

/** A request that never reached the server, as opposed to one it refused. */
export function noteNetworkFailure() {
  if (simulated) return
  failed = true
  recompute()
}

/** A request that did reach the server, whatever it answered. */
export function noteNetworkSuccess() {
  if (!failed) return
  failed = false
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
  snapshot = { offline: browserOffline(), simulated: false }
}
