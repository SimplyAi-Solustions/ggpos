import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, type PanInfo } from "motion/react"
import { X } from "lucide-react"

import { cn } from "@/lib/cn"
import { useMediaQuery, WIDE_QUERY } from "@/lib/use-media"
import { IconButton } from "@/ui/IconButton"

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: React.ReactNode
  /** Sticky actions at the bottom, above the safe area. */
  footer?: React.ReactNode
  className?: string
}

/**
 * A bottom sheet on phones (slides up, drag down to dismiss) and a centred
 * panel from tablet width. Escape and the backdrop close it; focus moves in
 * on open and back to where it was on close.
 */
export function Sheet({ open, onClose, title, description, children, footer, className }: SheetProps) {
  const wide = useMediaQuery(WIDE_QUERY)
  const titleId = React.useId()
  const descId = React.useId()
  const panelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const frame = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [open, onClose])

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose()
  }

  const motionProps = wide
    ? {
        initial: { opacity: 0, scale: 0.96, y: 12 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.97, y: 8 },
      }
    : {
        initial: { y: "100%" },
        animate: { y: 0 },
        exit: { y: "100%" },
        drag: "y" as const,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0, bottom: 0.6 },
        onDragEnd,
      }

  if (typeof document === "undefined") return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
          <motion.div
            className="absolute inset-0 bg-[var(--backdrop)] backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
            className={cn(
              "relative flex max-h-[92dvh] w-full flex-col overflow-hidden border border-line-2 bg-bg-2 shadow-sheet outline-none",
              "rounded-t-[var(--radius-lg)] md:max-w-lg md:rounded-[var(--radius-lg)]",
              className
            )}
            {...motionProps}
          >
            <div className="flex justify-center pt-2.5 md:hidden" aria-hidden>
              <span className="h-1.5 w-10 rounded-full bg-line-2" />
            </div>
            <div className="flex items-start justify-between gap-3 px-5 pt-3 pb-2 md:pt-5">
              <div className="min-w-0">
                <h2 id={titleId} className="font-display text-2xl uppercase tracking-wide">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="text-sm text-fg-2">
                    {description}
                  </p>
                )}
              </div>
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X aria-hidden />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
            {footer && (
              <div className="border-t border-line px-5 pt-3 pb-[calc(12px+var(--safe-bottom))] md:pb-4">
                {footer}
              </div>
            )}
            {!footer && <div className="pb-[var(--safe-bottom)] md:hidden" />}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}
