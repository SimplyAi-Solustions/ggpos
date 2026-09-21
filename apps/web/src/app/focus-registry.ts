/**
 * Two fields on a counter screen are addressable by keyboard from anywhere:
 * the scan field (`s`) and the screen's own search box (`/`). A screen that
 * has one registers it on mount; the shortcut handler asks for it and falls
 * back to navigating or to the command palette when nothing is registered.
 */

type Field = HTMLInputElement | null

let scanField: Field = null
let searchField: Field = null

export function registerScanField(element: Field): () => void {
  scanField = element
  return () => {
    if (scanField === element) scanField = null
  }
}

export function registerSearchField(element: Field): () => void {
  searchField = element
  return () => {
    if (searchField === element) searchField = null
  }
}

export function isScanField(element: Element | null): boolean {
  return scanField !== null && element === scanField
}

function focus(element: Field): boolean {
  if (!element || !element.isConnected) return false
  element.focus()
  element.select?.()
  return true
}

/** True when a scan field on this screen took focus. */
export function focusScanField(): boolean {
  return focus(scanField)
}

/** True when a search field on this screen took focus. */
export function focusSearchField(): boolean {
  return focus(searchField)
}
