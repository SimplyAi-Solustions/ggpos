/**
 * Printing, kept apart from the component that draws the page so the sheet
 * file exports components and nothing else.
 */

export type PrintSize = "a4" | "card80x50" | "wallet"

/** Sends the page to the printer. Kiosk printing skips the dialog. */
export function printPage() {
  window.print()
}
