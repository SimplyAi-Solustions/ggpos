import * as React from "react"
import { cn } from "cn"

/**
 * The barcode glyph from the reference screens: filled vertical bars, sized and
 * coloured like a Lucide icon so it can sit in any `leadingIcon` slot.
 */
function BarcodeGlyph({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  const bars: Array<[number, number]> = [
    [2.5, 1.1],
    [4.4, 0.7],
    [5.9, 1.6],
    [8.3, 0.7],
    [9.8, 1.1],
    [11.7, 0.7],
    [13.2, 1.9],
    [15.9, 0.7],
    [17.4, 1.1],
    [19.3, 0.7],
    [20.8, 1.1],
  ]

  return (
    <svg
      data-slot="barcode-glyph"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0", className)}
      {...props}
    >
      {bars.map(([x, w]) => (
        <rect key={x} x={x} y={3.5} width={w} height={17} />
      ))}
    </svg>
  )
}

/**
 * The loading state everywhere in GG Vault: a thin ring at the icon's stroke
 * weight, turning once every 720ms. No dots, no pulsing blocks.
 */
function RingSpinner({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="ring-spinner"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0 animate-ring-spin", className)}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  )
}

export { BarcodeGlyph, RingSpinner }
