import * as React from "react"
import { cn } from "cn"

/**
 * A sheet of paper that prints on its own.
 *
 * The customer card and the buy-in receipt live inside the counter shell, so
 * printing them straight would print the nav, the dock and the grain with
 * them. While one of these is mounted it installs two rules: an `@page` of
 * the right size, and a print rule that hides everything on the page except
 * this sheet. `visibility` rather than `display` is what makes that work:
 * hiding an ancestor with `display: none` would take the sheet with it,
 * while `visibility: hidden` can be turned back on further down the tree.
 *
 * The rules are scoped to `[data-print-sheet]`, so they are gone the moment
 * the screen unmounts and no other screen ever inherits them.
 */

import type { PrintSize } from "@/components/print/print"

const PAGE_RULE: Record<PrintSize, string> = {
  a4: "@page { size: A4; margin: 18mm }",
  card80x50: "@page { size: 80mm 50mm; margin: 0 }",
  wallet: "@page { size: 85.6mm 53.98mm; margin: 0 }",
}

function printCss(size: PrintSize): string {
  return `
${PAGE_RULE[size]}
@media print {
  html, body { background: #ffffff; }
  body::before { display: none !important; }
  body * { visibility: hidden !important; }
  [data-print-sheet], [data-print-sheet] * { visibility: visible !important; }
  [data-print-sheet] {
    position: absolute !important;
    inset: 0 auto auto 0;
    margin: 0 !important;
    box-shadow: none !important;
  }
  [data-print-hide] { display: none !important; }
}
`
}

export interface PrintSheetProps extends React.ComponentProps<"div"> {
  size: PrintSize
}

/** Wrap the thing that should be the printed page, and nothing else. */
export function PrintSheet({ size, className, children, ...props }: PrintSheetProps) {
  return (
    <>
      <style>{printCss(size)}</style>
      <div data-print-sheet="" className={cn("bg-background", className)} {...props}>
        {children}
      </div>
    </>
  )
}

/** Everything on a print screen that is for the person at the counter only. */
export function PrintControls({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-print-hide=""
      className={cn("flex flex-wrap items-center gap-8", className)}
      {...props}
    />
  )
}
