import * as React from "react"
import { cn } from "cn"

type ScaleToFitProps = {
  /** The width the child is designed for; capped at the real viewport width. */
  designWidth?: number
  className?: string
  children: React.ReactNode
}

/**
 * Renders a full screen at its real width inside a narrow column, scaled down
 * so a rebuild and its reference can sit side by side at the same scale.
 * Never scales up, so at phone width the child renders 1:1.
 */
export function ScaleToFit({
  designWidth = 1440,
  className,
  children,
}: ScaleToFitProps) {
  const outerRef = React.useRef<HTMLDivElement>(null)
  const innerRef = React.useRef<HTMLDivElement>(null)
  const [scale, setScale] = React.useState(1)
  const [target, setTarget] = React.useState(designWidth)
  const [innerHeight, setInnerHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    const measure = () => {
      const nextTarget = Math.min(designWidth, window.innerWidth)
      setTarget(nextTarget)
      setScale(Math.min(1, outer.clientWidth / nextTarget))
      // offsetHeight is the untransformed layout height, which is what we want.
      setInnerHeight(inner.offsetHeight)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    window.addEventListener("resize", measure)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [designWidth])

  return (
    <div
      ref={outerRef}
      className={cn("relative w-full overflow-hidden", className)}
      style={innerHeight ? { height: Math.round(innerHeight * scale) } : undefined}
    >
      <div
        ref={innerRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: target, transform: `scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  )
}
