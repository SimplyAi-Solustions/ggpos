/**
 * Passing a referral code on: the share sheet, and what happens when there
 * is not one.
 *
 * The Web Share API only exists on a phone and only on a secure origin, so
 * the button has to know which of the two things it is before it is pressed:
 * "Share my code" opens the sheet, "Copy my code" puts the code on the
 * clipboard. Both outcomes are said out loud afterwards, and a browser that
 * can do neither is told so rather than left looking like it worked.
 *
 * Pure but for the two capabilities it is handed, so all four paths are unit
 * tested without a browser.
 */

export type ShareResult = "shared" | "cancelled" | "copied" | "failed"

export interface SharePayload {
  title: string
  text: string
  url?: string
  /** What goes on the clipboard when there is no share sheet. */
  copy: string
}

/** The two browser capabilities this needs, so a test can hand it either. */
export interface ShareTarget {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

/** What this browser can actually do, read once at render. */
export function browserShareTarget(): ShareTarget {
  if (typeof navigator === "undefined") return {}
  const target: ShareTarget = {}
  if (typeof navigator.share === "function") {
    target.share = (data) => navigator.share(data)
  }
  // `navigator.clipboard` is undefined outside a secure origin, and its
  // `writeText` can still be missing where the object exists.
  const clipboard = navigator.clipboard as Clipboard | undefined
  if (clipboard && typeof clipboard.writeText === "function") {
    target.writeText = (text) => clipboard.writeText(text)
  }
  return target
}

/** "Share my code" when there is a sheet to open, "Copy my code" when not. */
export function shareActionLabel(target: ShareTarget): string {
  return target.share ? "Share my code" : "Copy my code"
}

/** What to say once it has happened. Never an exclamation, never a toast. */
export function shareResultSentence(result: ShareResult, code: string): string | null {
  switch (result) {
    case "shared":
      return "Code shared."
    case "copied":
      return "Code copied."
    case "cancelled":
      return null
    default:
      return `Your browser would not copy it. The code is ${code}.`
  }
}

/**
 * Opens the share sheet, and falls back to the clipboard.
 *
 * A cancelled share is not a failure and must not quietly copy instead: the
 * person closed the sheet on purpose. Anything else the share throws (an
 * insecure origin, a missing user gesture) does fall through to the
 * clipboard, because then nothing has happened yet.
 */
export async function shareOrCopy(
  payload: SharePayload,
  target: ShareTarget = browserShareTarget()
): Promise<ShareResult> {
  if (target.share) {
    try {
      await target.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
      })
      return "shared"
    } catch (error) {
      if (isAbort(error)) return "cancelled"
    }
  }
  if (target.writeText) {
    try {
      await target.writeText(payload.copy)
      return "copied"
    } catch {
      return "failed"
    }
  }
  return "failed"
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError"
}
