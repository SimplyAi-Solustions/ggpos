/**
 * Keeping the customer-facing screen in step with a counter screen.
 *
 * The till publishes on a 400ms debounce and only when the payload actually
 * changed, so scanning five items is five repaints of the tablet rather than
 * fifty, and a screen that re-renders for its own reasons does not put the
 * tablet through anything at all. When the screen has nothing to show any
 * more (an empty basket, a finished sale, a counter screen being left) the
 * display goes back to the shop's own idle page.
 */
import * as React from "react"

import { samePayload } from "@/features/display/payload"
import { clearDisplay, publishDisplay } from "@/lib/api/display"
import type { DisplayMode, DisplayPayload } from "@/lib/api/types"

/** Milliseconds between the last change and the publish. */
export const PUBLISH_DEBOUNCE_MS = 400

/**
 * Publishes `payload` to the display whenever it changes, and clears the
 * display when it becomes null or the screen goes away.
 *
 * `enabled` is `settings.display.enabled`: with the display switched off
 * nothing is ever sent, and nothing needs clearing either.
 */
export function useDisplayPublish(
  enabled: boolean,
  mode: DisplayMode,
  payload: DisplayPayload | null,
  delay: number = PUBLISH_DEBOUNCE_MS
): void {
  // What is on the tablet now, as far as this screen knows. `undefined`
  // means nothing has been sent from here yet, which is not the same as
  // having sent the idle screen.
  const shown = React.useRef<DisplayPayload | null | undefined>(undefined)
  // The payload as text, so the effect runs on a change of content rather
  // than on every new object the render made.
  const key = payload === null ? "" : JSON.stringify(payload)

  React.useEffect(() => {
    if (!enabled) return undefined
    const next = key === "" ? null : (JSON.parse(key) as DisplayPayload)
    if (shown.current !== undefined && samePayload(shown.current, next)) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      const previous = shown.current
      shown.current = next
      const sent =
        next === null
          ? previous === undefined
            ? Promise.resolve()
            : clearDisplay()
          : publishDisplay(mode, next).then(() => undefined)
      // A publish that does not land leaves the tablet showing what it had;
      // forgetting it here means the next change tries again rather than
      // deciding nothing has moved.
      void sent.catch(() => {
        shown.current = previous
      })
    }, delay)

    return () => window.clearTimeout(timer)
  }, [enabled, mode, key, delay])

  React.useEffect(() => {
    return () => {
      if (shown.current === undefined || shown.current === null) return
      shown.current = null
      void clearDisplay().catch(() => {})
    }
  }, [])
}
