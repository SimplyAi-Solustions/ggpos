import * as React from "react"

import { cn } from "@/lib/cn"

export interface CardImageProps {
  src: string
  alt: string
  /** Rendered width in px; height follows the 63:88 card ratio. */
  width: number
  className?: string
  /** Eager for the one hero image on a page. */
  priority?: boolean
}

/**
 * A card picture at the 63:88 card ratio with the drop shadow that follows
 * the card's own rounded edge (DESIGN.md, "Product imagery"). While it loads
 * a silhouette sits behind it; the image itself never renders at zero
 * opacity. With no image, the silhouette stays and says so.
 */
export function CardImage({ src, alt, width, className, priority }: CardImageProps) {
  const height = Math.round((width * 88) / 63)
  const [failed, setFailed] = React.useState(false)
  const show = Boolean(src) && !failed
  return (
    <span
      className={cn("relative inline-block shrink-0 rounded-[4.5%/3.2%] bg-line", className)}
      style={{ width, height }}
    >
      {show ? (
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
          className="relative size-full object-contain [filter:drop-shadow(0_1px_1px_rgba(11,11,11,.06))_drop-shadow(0_10px_20px_rgba(11,11,11,.14))]"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center p-1 text-center font-mono text-[9px] leading-tight text-fg-3">
          {width >= 80 ? "No image yet" : ""}
        </span>
      )}
    </span>
  )
}
