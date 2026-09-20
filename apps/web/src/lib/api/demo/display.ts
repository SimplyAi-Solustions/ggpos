/**
 * The demo shop's customer-facing display.
 *
 * The one demo store that is not purely in memory, and for one reason: the
 * display is a second screen. The counter publishes from one page and the
 * tablet renders on another, so the two need a channel between them, and in
 * demo mode there is no PocketBase realtime to be that channel. The state
 * lives under one `localStorage` key for the origin, and a change reaches
 * the other page through the browser's own `storage` event (which never
 * fires in the page that wrote it, so a local emitter covers that side).
 *
 * Nothing here is a record: it is the same throwaway state the real
 * `display_state` row holds, and clearing site data clears it.
 */
import { scrubPayload } from "@/features/display/payload"
import type { DisplayMode, DisplayPayload, DisplayState } from "@/lib/api/types"

const KEY = "gg-demo-display"

/** Fifteen minutes, the same window a stale publish clears itself after. */
const LIFETIME_MS = 15 * 60_000

export const IDLE: DisplayState = {
  mode: "idle",
  payload: {},
  token: "",
  customer_accepted_at: "",
  expires_at: "",
}

const listeners = new Set<(state: DisplayState) => void>()

function read(): DisplayState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return IDLE
    const parsed = JSON.parse(raw) as DisplayState
    if (parsed.expires_at && new Date(parsed.expires_at) < new Date()) return IDLE
    return parsed
  } catch {
    return IDLE
  }
}

function write(state: DisplayState): DisplayState {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // Private browsing: the display simply does not follow this tab.
  }
  for (const listener of listeners) listener(state)
  return state
}

export function demoDisplayState(): DisplayState {
  return read()
}

export function demoPublishDisplay(
  mode: DisplayMode,
  payload: DisplayPayload
): { token: string } {
  const token = `tok_${Math.random().toString(36).slice(2, 10)}`
  write({
    mode,
    payload: scrubPayload(mode, payload),
    token,
    customer_accepted_at: "",
    expires_at: new Date(Date.now() + LIFETIME_MS).toISOString(),
  })
  return { token }
}

export function demoClearDisplay(): DisplayState {
  return write({ ...IDLE })
}

/** The kiosk's own accept. 409 in the same words the route uses. */
export function demoAcceptDisplay(token: string): DisplayState {
  const state = read()
  if (state.mode !== "buy_in" || !state.token || state.token !== token) {
    throw new Error("That offer is no longer on the display. Ask the counter to send it again.")
  }
  return write({ ...state, customer_accepted_at: new Date().toISOString() })
}

/** Both directions: this page's own writes, and the other page's. */
export function subscribeDemoDisplay(
  onChange: (state: DisplayState) => void
): () => void {
  listeners.add(onChange)
  const fromOtherPage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return
    onChange(read())
  }
  window.addEventListener("storage", fromOtherPage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", fromOtherPage)
  }
}
