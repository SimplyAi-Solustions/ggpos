import * as React from "react"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"

type SealProps = React.ComponentProps<"div"> & {
  /** "DONE" by default; a tick when `label` is omitted and `tick` is set. */
  label?: string
  tick?: boolean
}

/**
 * The brand done-seal: an 84px volt disc with a 2px ink edge and the site's
 * hard 4px offset shadow. It only ever appears on a success screen, once.
 * This is the one place in GG Vault that uses a zero-blur shadow; it is a
 * deliberate quote of the marketing site's `--shadow: 6px 6px 0 var(--ink)`.
 */
function Seal({ className, label = "DONE", tick = false, ...props }: SealProps) {
  return (
    <div
      data-slot="seal"
      role="img"
      aria-label={tick ? "Done" : label}
      className={cn(
        "flex size-21 items-center justify-center rounded-full border-2 border-foreground bg-volt",
        "shadow-[4px_4px_0_var(--foreground)]",
        className
      )}
      {...props}
    >
      {tick ? (
        <CheckIcon className="size-9 stroke-[1.5] text-gg-ink" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className="font-display text-[20px] leading-none tracking-[0.04em] text-gg-ink uppercase"
        >
          {label}
        </span>
      )}
    </div>
  )
}

export { Seal }
