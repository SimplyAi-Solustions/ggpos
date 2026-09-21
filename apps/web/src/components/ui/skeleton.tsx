import * as React from "react"
import { cn } from "cn"

/**
 * Loading is drawn as hairlines, never as a spinner or a shimmering gradient:
 * the block that will arrive, outlined at the size it will be.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "rounded-[var(--radius)] border border-hairline-soft bg-hairline-faint",
        "animate-pulse motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

/** A stack of hairline text lines, the last one short. */
function SkeletonText({
  lines = 3,
  className,
  ...props
}: React.ComponentProps<"div"> & { lines?: number }) {
  return (
    <div
      data-slot="skeleton-text"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-2/5" : "w-full")}
        />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonText }
