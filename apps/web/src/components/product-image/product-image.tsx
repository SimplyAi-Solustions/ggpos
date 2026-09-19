import * as React from "react"
import { cn } from "cn"

import {
  frameSize,
  platformSpec,
  type PlatformKey,
  type ProductFinish,
} from "@/design/platforms"
import {
  bestThumbWidth,
  isPocketBaseFileUrl,
  thumbSrcSet,
  thumbUrl,
} from "@/components/product-image/thumb-url"

type ProductImageProps = Omit<
  React.ComponentProps<"div">,
  "children" | "onLoad" | "width" | "height"
> & {
  src?: string | null
  alt: string
  /** Key from the platforms table. Sets the ratio and the default finish. */
  platform?: PlatformKey | string
  /** Overrides the table, for one-off art. */
  ratio?: readonly [number, number]
  /** `shadow` for cut-outs with transparent corners, `edge` for box art. */
  finish?: ProductFinish
  /** Give one of these; height is the one lists and tables use. */
  height?: number
  width?: number
  loading?: "lazy" | "eager"
  /** Above the fold: loads eagerly and asks the browser to hurry. */
  priority?: boolean
  imgClassName?: string
}

/**
 * Every card, cartridge, box, console and sealed product in GG Vault renders
 * through this. The frame is the exact ratio for what the thing is, the image
 * is `contain` on the canvas colour, nothing is ever cropped, and the `<img>`
 * carries real width and height so a list never shifts while it loads.
 */
function ProductImage({
  className,
  imgClassName,
  src,
  alt,
  platform,
  ratio,
  finish,
  height,
  width,
  loading = "lazy",
  priority = false,
  ...props
}: ProductImageProps) {
  const spec = platformSpec(platform)
  const frameRatio = ratio ?? spec.ratio
  const resolvedFinish = finish ?? spec.finish
  const size = frameSize(frameRatio, {
    height: height ?? (width === undefined ? 160 : undefined),
    width,
  })

  const [loaded, setLoaded] = React.useState(false)
  const isEdge = resolvedFinish === "edge"
  const resolvedSrc = src
    ? isPocketBaseFileUrl(src)
      ? thumbUrl(src, bestThumbWidth(size.width))
      : src
    : undefined

  return (
    <div
      data-slot="product-image"
      data-finish={resolvedFinish}
      data-platform={platform ?? "other"}
      className={cn("relative shrink-0 bg-background", className)}
      style={{ width: size.width, height: size.height }}
      {...props}
    >
      {/* The silhouette: the shape it will be, in ink at 4 percent. */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-silhouette transition-opacity duration-150 ease-gg",
          isEdge ? "rounded-none" : "rounded-[var(--radius)]",
          loaded && "opacity-0"
        )}
      />

      {resolvedSrc ? (
        <img
          src={resolvedSrc}
          srcSet={thumbSrcSet(resolvedSrc)}
          sizes={`${size.width}px`}
          alt={alt}
          width={size.width}
          height={size.height}
          loading={priority ? "eager" : loading}
          decoding={priority ? "sync" : "async"}
          fetchPriority={priority ? "high" : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          className={cn(
            "absolute inset-0 size-full object-contain transition-opacity duration-150 ease-gg",
            loaded ? "opacity-100" : "opacity-0",
            imgClassName
          )}
          style={
            isEdge
              ? undefined
              : {
                  filter:
                    "drop-shadow(0 1px 1px rgba(11,11,11,.05)) drop-shadow(0 12px 24px rgba(11,11,11,.10))",
                }
          }
        />
      ) : null}

      {/* The edge finish: a hairline around the art plus a 1px printed offset. */}
      {isEdge ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 border border-product-edge shadow-[-1px_1px_0_0_var(--product-edge-offset)]"
        />
      ) : null}
    </div>
  )
}

export { ProductImage }
export type { ProductImageProps }
