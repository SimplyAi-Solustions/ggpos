/**
 * Step-up: the second password check that refunds and the ID photo view
 * need (docs/api-contract.md, "Step-up").
 *
 * `stepUp()` hands back a token, asking for the password only when the last
 * one has run out. The token lives for ten minutes in this module and
 * nowhere else: never localStorage, never a cookie, so it dies with the tab
 * and a shared counter PC cannot inherit somebody else's confirmation.
 *
 * The prompt is a `Dialog` rather than a sheet because it is the one kind of
 * task DESIGN.md says needs protected focus.
 */
import { createElement } from "react"
import type { Root } from "react-dom/client"

import { getStepUp } from "@/lib/api/sales"
import type { StepUpToken } from "@/lib/api/types"

/** Thirty seconds of headroom, so a token never expires mid-request. */
const SAFETY_MS = 30_000

let cached: StepUpToken | null = null

/**
 * Asks the person for their password and resolves with it, or with null when
 * they close the dialog. The default opens the paper dialog in
 * `auth-stepup-dialog.tsx`; tests and the screenshot script swap it out.
 */
export type StepUpPrompt = () => Promise<string | null>

let prompt: StepUpPrompt | null = null

/** Replaces the dialog, for a test or a host that owns its own prompt. */
export function setStepUpPrompt(next: StepUpPrompt | null): () => void {
  prompt = next
  return () => {
    if (prompt === next) prompt = null
  }
}

let host: HTMLDivElement | null = null
let root: Root | null = null

/**
 * Mounts the dialog on its own root beside the app, so a caller awaits one
 * promise and no screen has to carry the prompt in its tree. Loaded on
 * demand: a counter that never refunds anything never pays for the dialog,
 * and a unit test that swaps the prompt never needs a DOM for it.
 */
async function ask(): Promise<string | null> {
  if (prompt) return prompt()
  if (typeof document === "undefined") return null

  const [{ StepUpDialog }, { createRoot }] = await Promise.all([
    import("@/lib/auth-stepup-dialog"),
    import("react-dom/client"),
  ])

  if (!host) {
    host = document.createElement("div")
    host.setAttribute("data-slot", "step-up-host")
    document.body.appendChild(host)
    root = createRoot(host)
  }

  return new Promise((resolve) => {
    root?.render(
      createElement(StepUpDialog, {
        onDone: (password: string | null) => {
          // Let the dialog play its 200ms exit before it is torn down.
          window.setTimeout(() => root?.render(null), 250)
          resolve(password)
        },
      })
    )
  })
}

/** True while a confirmation from the last ten minutes still stands. */
export function hasStepUp(now: number = Date.now()): boolean {
  if (!cached) return false
  return new Date(cached.expiresAt).getTime() - SAFETY_MS > now
}

/** Exported for the tests and for sign-out. */
export function clearStepUp() {
  cached = null
}

/** Exported for the tests: seeds the cache without a round trip. */
export function setStepUpToken(token: StepUpToken | null) {
  cached = token
}

export class StepUpCancelled extends Error {
  constructor() {
    super("Confirm your password to continue.")
    this.name = "StepUpCancelled"
  }
}

/**
 * The token for a sensitive call. Returns the cached one when it is still
 * good, otherwise prompts once and caches what comes back. Throws
 * `StepUpCancelled` when the person closes the dialog.
 */
export async function stepUp(): Promise<string> {
  if (cached && hasStepUp()) return cached.token
  cached = null

  const password = await ask()
  if (password === null) throw new StepUpCancelled()

  const token = await getStepUp(password)
  cached = token
  return token.token
}
