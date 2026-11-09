import { cn } from "@/lib/cn"

export interface SkeletonProps {
  className?: string
  /** Renders that many text-height bars, the last one shorter. */
  lines?: number
}

/** A loading placeholder with a soft shimmer. */
export function Skeleton({ className, lines }: SkeletonProps) {
  const bar = "relative overflow-hidden rounded-sm bg-line before:absolute before:inset-0 before:-translate-x-full before:animate-[gg-shimmer_1.4s_infinite] before:bg-gradient-to-r before:from-transparent before:via-line-2 before:to-transparent"
  if (lines && lines > 0) {
    return (
      <div className={cn("flex flex-col gap-2", className)} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cn(bar, "h-4", i === lines - 1 && lines > 1 && "w-2/3")} />
        ))}
      </div>
    )
  }
  return <div className={cn(bar, "h-4", className)} aria-hidden />
}
