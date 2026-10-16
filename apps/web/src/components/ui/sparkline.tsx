import * as React from "react"
import { cn } from "cn"

/**
 * A 30-day line under a Home tile: one ink polyline, no axes, no fill, no
 * dots, no grid. It carries the shape of the month and nothing else, so it
 * is `aria-hidden` and the sentence beside it is what a screen reader gets.
 *
 * Values are integer pence. The line is drawn against its own minimum and
 * maximum, so a quiet month is not a flat line at the bottom of the box, and
 * a run of zeroes draws along the baseline rather than dividing by nothing.
 */
export interface SparklineProps extends Omit<React.ComponentProps<"svg">, "values"> {
  values: number[]
  /** Drawn height in CSS pixels. DESIGN.md's tiles use 40. */
  height?: number
  /** Viewport width the path is computed in; the SVG itself scales to fit. */
  width?: number
}

export function Sparkline({
  values,
  height = 40,
  width = 240,
  className,
  ...props
}: SparklineProps) {
  const points = React.useMemo(() => {
    if (values.length === 0) return ""
    // One value would be a dot, not a line: draw it flat across the middle.
    if (values.length === 1) return `0,${height / 2} ${width},${height / 2}`

    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min
    const step = width / (values.length - 1)
    // 1.5px of padding top and bottom, so the stroke is never half cut off.
    const top = 1.5
    const usable = Math.max(1, height - top * 2)

    return values
      .map((value, index) => {
        const ratio = span === 0 ? 0.5 : (value - min) / span
        const y = top + usable - ratio * usable
        return `${(index * step).toFixed(2)},${y.toFixed(2)}`
      })
      .join(" ")
  }, [values, height, width])

  if (!points) return null

  return (
    <svg
      data-slot="sparkline"
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full text-foreground", className)}
      style={{ height }}
      {...props}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
