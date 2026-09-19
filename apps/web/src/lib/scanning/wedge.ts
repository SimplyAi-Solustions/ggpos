/**
 * The global keyboard-wedge listener.
 *
 * A USB barcode scanner is a keyboard that types very fast and presses Enter.
 * This turns that into one `onScan` call from anywhere in the counter app,
 * without a field having focus and without a click.
 *
 * The rules, in order:
 *  - Keystrokes less than `maxGapMs` apart belong to the same scan; a slower
 *    key starts a fresh buffer, so a person typing is never mistaken for a gun.
 *  - Enter commits. A buffer shorter than `minLength` is dropped, which keeps
 *    a stray Enter on the page from firing a scan.
 *  - An optional `prefix` character (set per shop in settings, none by
 *    default) must open the buffer and is stripped before committing.
 *  - While a text field, textarea or contenteditable has focus the listener
 *    stays out of the way, with one exception: the scan field itself, which
 *    commits its own value on Enter at any typing speed, so staff can type a
 *    SKU by hand.
 */

export interface WedgeOptions {
  /** Called with the scanned string, prefix already removed. */
  onScan: (code: string) => void
  /** Shortest buffer worth committing. Default 6. */
  minLength?: number
  /** Longest gap between two keystrokes of one scan, in ms. Default 50. */
  maxGapMs?: number
  /** Shop-specific prefix character, or null for none. Default null. */
  prefix?: string | null
  /** Marks the app's own scan input, which commits its value on Enter. */
  isScanField?: (element: Element | null) => boolean
  /** Swappable for tests. */
  target?: Pick<Document, "addEventListener" | "removeEventListener">
  now?: () => number
}

function isEditable(element: Element | null): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type
    return type !== "checkbox" && type !== "radio" && type !== "button"
  }
  return (element as HTMLElement).isContentEditable === true
}

/**
 * Starts listening. Returns the function that stops it, so a React effect can
 * hand it straight back.
 */
export function createWedgeListener(options: WedgeOptions): () => void {
  const {
    onScan,
    minLength = 6,
    maxGapMs = 50,
    prefix = null,
    isScanField = () => false,
    target = document,
    now = () => Date.now(),
  } = options

  let buffer = ""
  let lastKeyAt = 0

  function commit(raw: string) {
    let value = raw
    if (prefix) {
      if (!value.startsWith(prefix)) return
      value = value.slice(prefix.length)
    }
    if (value.length < minLength) return
    onScan(value)
  }

  function handleKeyDown(event: Event) {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.metaKey || keyboardEvent.ctrlKey || keyboardEvent.altKey) return

    const active = keyboardEvent.target as Element | null
    const onScanField = isScanField(active)

    // The scan field is a text field on purpose: staff type into it. It
    // commits what it holds, whatever speed it was typed at.
    if (onScanField) {
      if (keyboardEvent.key === "Enter") {
        const value = (active as HTMLInputElement | null)?.value?.trim() ?? ""
        buffer = ""
        if (value) {
          keyboardEvent.preventDefault()
          onScan(value)
        }
      }
      return
    }

    // Any other field belongs to whoever is typing in it.
    if (isEditable(active)) {
      buffer = ""
      return
    }

    if (keyboardEvent.key === "Enter") {
      const captured = buffer
      buffer = ""
      if (captured.length >= minLength) keyboardEvent.preventDefault()
      commit(captured)
      return
    }

    if (keyboardEvent.key.length !== 1) return

    const at = now()
    buffer = at - lastKeyAt > maxGapMs ? keyboardEvent.key : buffer + keyboardEvent.key
    lastKeyAt = at
  }

  target.addEventListener("keydown", handleKeyDown, true)
  return () => target.removeEventListener("keydown", handleKeyDown, true)
}
