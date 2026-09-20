/**
 * The marketing site's yellow ticker, and the only place it appears in the
 * app: the customer-facing screen while nothing is on it.
 *
 * Ink on volt, which is the one way volt may carry text. The run is written
 * out twice and translated by exactly half, so the loop has no seam, and the
 * whole thing stops under `prefers-reduced-motion` (theme.css zeroes every
 * animation, and the inline guard says so here too rather than leaving it to
 * a file nobody reads).
 */
export interface TickerProps {
  text: string
  /** Seconds for one pass. Slow: it is read across a counter, not scanned. */
  seconds?: number
}

export function Ticker({ text, seconds = 48 }: TickerProps) {
  const line = text.trim()
  if (!line) return null

  const run = (
    <span className="flex shrink-0 items-center">
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="flex items-center">
          <span className="px-6 font-mono text-[14px] leading-none font-bold tracking-[0.08em] text-gg-ink">
            {line}
          </span>
          <span aria-hidden="true" className="text-[12px] leading-none text-gg-ink">
            &#9670;
          </span>
        </span>
      ))}
    </span>
  )

  return (
    <div
      data-testid="display-ticker"
      className="w-full overflow-hidden bg-volt py-3"
      aria-label={line}
    >
      <style>{`
        @keyframes gg-ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) {
          [data-slot="ticker-rail"] { animation: none !important; }
        }
      `}</style>
      <div
        data-slot="ticker-rail"
        aria-hidden="true"
        className="flex w-max"
        style={{ animation: `gg-ticker ${seconds}s linear infinite` }}
      >
        {run}
        {run}
      </div>
    </div>
  )
}
