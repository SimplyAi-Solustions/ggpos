/**
 * The customer-facing display: what the counter publishes to it, and how the
 * tablet and the buy-in wizard follow it.
 *
 * One row, `display_state`, written only through the routes in the Phase 6
 * list so the server can strip the payload and mint a fresh token on every
 * publish. Both the kiosk and the wizard subscribe to that row over
 * PocketBase realtime, which is how an accept on the tablet reaches the
 * phone in the staff member's hand.
 *
 * The payload is built by `features/display/payload.ts` and scrubbed again
 * here: nothing carrying a record id, a phone number or an email address
 * ever goes to a screen the shop can see.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { scrubPayload } from "@/features/display/payload"
import {
  demoAcceptDisplay,
  demoClearDisplay,
  demoDisplayState,
  demoPublishDisplay,
  subscribeDemoDisplay,
  IDLE,
} from "@/lib/api/demo/display"
import type { DisplayMode, DisplayPayload, DisplayState } from "@/lib/api/types"

/** The `display_state` row as PocketBase serves it. */
interface DisplayRow {
  id: string
  mode?: DisplayMode
  payload?: unknown
  token?: string
  customer_accepted_at?: string
  expires_at?: string
}

function fromRow(row: DisplayRow | undefined | null): DisplayState {
  if (!row) return { ...IDLE }
  const mode = row.mode ?? "idle"
  return {
    mode,
    payload: scrubPayload(mode, row.payload),
    token: row.token ?? "",
    customer_accepted_at: row.customer_accepted_at ?? "",
    expires_at: row.expires_at ?? "",
  }
}

/** What is on the display now. */
export async function getDisplayState(): Promise<DisplayState> {
  if (isDemo()) return demoDisplayState()
  const page = await pb.collection("display_state").getList<DisplayRow>(1, 1)
  return fromRow(page.items[0])
}

/**
 * Replaces what the display shows. The token comes back so the publisher can
 * tell its own offer's accept from a later one's.
 */
export async function publishDisplay(
  mode: DisplayMode,
  payload: DisplayPayload
): Promise<{ token: string }> {
  const body = { mode, payload: scrubPayload(mode, payload) }
  if (isDemo()) return demoPublishDisplay(mode, body.payload)
  return pb.send<{ token: string }>("/api/vault/display", {
    method: "POST",
    body,
  })
}

/** Back to the idle screen: the ticker and the sign-up QR. */
export async function clearDisplay(): Promise<void> {
  if (isDemo()) {
    demoClearDisplay()
    return
  }
  await pb.send("/api/vault/display/clear", { method: "POST", body: {} })
}

/** The kiosk's own accept, from the tablet's session. */
export async function acceptDisplay(token: string): Promise<void> {
  if (isDemo()) {
    demoAcceptDisplay(token)
    return
  }
  await pb.send("/api/vault/display/accept", { method: "POST", body: { token } })
}

/**
 * Follows the row. The callback is handed the whole state on every change,
 * and the returned function stops listening.
 *
 * Live mode subscribes before it reads, so a change that lands between the
 * two is not missed; demo mode listens to the other page's `localStorage`
 * writes, which is the same idea with the browser as the broker.
 */
export function subscribeDisplay(
  onChange: (state: DisplayState) => void
): () => void {
  if (isDemo()) {
    const stop = subscribeDemoDisplay(onChange)
    onChange(demoDisplayState())
    return stop
  }

  let live = true
  let unsubscribe: (() => void) | null = null

  void pb
    .collection("display_state")
    .subscribe<DisplayRow>("*", (event) => onChange(fromRow(event.record)))
    .then((stop) => {
      if (!live) {
        void stop()
        return
      }
      unsubscribe = stop
    })
    .catch(() => {
      // A dropped subscription is not a reason to blank the screen: the
      // state already on it stands until the next successful read.
    })

  void getDisplayState()
    .then((state) => {
      if (live) onChange(state)
    })
    .catch(() => {})

  return () => {
    live = false
    if (unsubscribe) void unsubscribe()
  }
}
