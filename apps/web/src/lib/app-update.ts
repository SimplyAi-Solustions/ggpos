/**
 * A tab left open across a release keeps running the build it loaded, and the
 * counter Mac's tab is open all day.
 *
 * The service worker fetches a new build by itself (`registerType:
 * "autoUpdate"` in vite.config.ts: it installs, skips waiting and takes over
 * the page), but the browser only asks it to look on a full page load, and
 * the page it takes over still runs the old code. So this asks for an update
 * every fifteen minutes and whenever the tab comes back into view, and once a
 * new worker has taken over from an old one, says so: the counter shows one
 * line with Reload. It never reloads by itself, because a ticket or a half
 * typed form is worth more than being current.
 *
 * A worker taking over a page that had none is the first install, not an
 * update, and says nothing.
 */
import * as React from "react"

const CHECK_EVERY_MS = 15 * 60_000

export interface ServiceWorkerContainerLike {
  controller: unknown
  addEventListener(type: "controllerchange", listener: () => void): void
  getRegistration(): Promise<{ update(): Promise<unknown> } | undefined>
}

interface Env {
  sw: ServiceWorkerContainerLike | undefined
  doc: Pick<Document, "addEventListener" | "visibilityState"> | undefined
  every: (fn: () => void, ms: number) => unknown
}

let ready = false
let watching = false
const listeners = new Set<() => void>()

function announce() {
  ready = true
  for (const listener of listeners) listener()
}

function browserEnv(): Env {
  return {
    sw: typeof navigator === "undefined" ? undefined : navigator.serviceWorker,
    doc: typeof document === "undefined" ? undefined : document,
    every: (fn, ms) => window.setInterval(fn, ms),
  }
}

/** Start looking for new builds. Once per page; later calls do nothing. */
export function watchForAppUpdate(env: Env = browserEnv()): void {
  if (watching || !env.sw) return
  watching = true
  const sw = env.sw
  let current = sw.controller

  sw.addEventListener("controllerchange", () => {
    const had = current
    current = sw.controller
    if (had) announce()
  })

  const check = () => {
    void sw
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined)
  }
  env.every(check, CHECK_EVERY_MS)
  env.doc?.addEventListener("visibilitychange", () => {
    if (env.doc?.visibilityState === "visible") check()
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const isReady = () => ready

/** True once a newer GG Vault has taken over this page. */
export function useAppUpdateReady(): boolean {
  return React.useSyncExternalStore(subscribe, isReady, isReady)
}

/** For tests: forget everything. */
export function resetAppUpdateForTests() {
  ready = false
  watching = false
  listeners.clear()
}
