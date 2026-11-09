import * as React from "react"

import { cn } from "@/lib/cn"

export type BadgeTone = "neutral" | "volt" | "pop" | "ok" | "warn" | "info" | "violet"

const tones: Record<BadgeTone, string> = {
  neutral: "border-line-2 text-fg-2",
  volt: "border-transparent bg-volt text-on-volt",
  pop: "border-transparent bg-pop text-on-pop",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  info: "border-info/40 text-info",
  violet: "border-accent-violet/40 text-accent-violet",
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  /** A leading dot. Status is never colour alone, so keep the text. */
  dot?: boolean
}

export function Badge({ tone = "neutral", dot, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "label-mono inline-flex h-6 w-fit items-center gap-1.5 rounded-full border px-2.5 text-[10px]",
        tones[tone],
        className
      )}
      {...rest}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  )
}
