import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { AlertTriangle, Check, Info } from "lucide-react"

import { cn } from "@/lib/cn"

export type ToastTone = "neutral" | "ok" | "alert"

export interface ToastOptions {
  message: string
  tone?: ToastTone
  /** Milliseconds before it goes. Default 3500. */
  duration?: number
}

interface ToastItem extends Required<ToastOptions> {
  id: number
}

type ToastFn = (options: ToastOptions | string) => void

const ToastContext = React.createContext<ToastFn | null>(null)

/** Shows a toast. Must be inside ToastProvider. */
export function useToast(): ToastFn {
  const toast = React.useContext(ToastContext)
  if (!toast) throw new Error("useToast needs a ToastProvider above it.")
  return toast
}

const icons = {
  neutral: <Info aria-hidden />,
  ok: <Check aria-hidden />,
  alert: <AlertTriangle aria-hidden />,
}

const iconTones = {
  neutral: "bg-line-2 text-fg",
  ok: "bg-volt text-on-volt",
  alert: "bg-pop text-on-pop",
}

let nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([])

  const dismiss = React.useCallback((id: number) => {
    setItems((list) => list.filter((item) => item.id !== id))
  }, [])

  const toast = React.useCallback<ToastFn>(
    (options) => {
      const opts = typeof options === "string" ? { message: options } : options
      const item: ToastItem = { id: nextId++, tone: "neutral", duration: 3500, ...opts }
      setItems((list) => [...list.slice(-2), item])
      window.setTimeout(() => dismiss(item.id), item.duration)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+12px)] z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.button
              key={item.id}
              type="button"
              layout
              initial={{ opacity: 0, y: 24, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 500, damping: 36 }}
              onClick={() => dismiss(item.id)}
              className="glass pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-full border border-line-2 py-2 pr-5 pl-2 text-left text-sm font-medium shadow-sheet"
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
                  iconTones[item.tone]
                )}
              >
                {icons[item.tone]}
              </span>
              <span className="min-w-0 flex-1">{item.message}</span>
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
