import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronDown, ChevronUp, Handshake, Layers, Minus, PackagePlus, Trash2 } from "lucide-react"

import { Button, Money, useToast } from "@/ui"
import { CardImage } from "@/features/cards/CardImage"
import { errorMessage } from "@/features/cards/api"
import { numberLabel } from "@/features/cards/format"

import { addManyToDealHref } from "./addToDeal"
import { removeLine, trayCount, trayTotal, trayUnits, type TrayLine } from "./tray"
import { createStockFromTray } from "./tray-state"

export interface TrayBarProps {
  lines: readonly TrayLine[]
  onChange: (lines: TrayLine[]) => void
  dealId?: string
}

/**
 * The running tray at the bottom of Scan while a batch is on: how many
 * cards and what they come to, "Add all to deal", "Add all to stock", and
 * the lines themselves when opened.
 */
export function TrayBar({ lines, onChange, dealId }: TrayBarProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const count = trayCount(lines)

  const toStock = async () => {
    setAdding(true)
    try {
      const made = await createStockFromTray(lines)
      toast({ message: `${made} ${made === 1 ? "card" : "cards"} added to stock.`, tone: "ok" })
      onChange([])
      setOpen(false)
    } catch (error) {
      toast({ message: errorMessage(error, "The cards were not added to stock. Try again."), tone: "alert" })
    } finally {
      setAdding(false)
    }
  }

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.aside
          key="tray"
          initial={reduce ? false : { y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? undefined : { y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
          aria-label="Scan tray"
          className="fixed inset-x-3 bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+0.5rem)] z-30 mx-auto max-w-xl rounded-lg border border-line bg-panel p-3 shadow-sheet [backdrop-filter:blur(18px)] md:bottom-4 md:left-auto md:right-6 md:w-[26rem]"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-volt text-on-volt shadow-volt">
              <Layers className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg">
                {count} {count === 1 ? "card" : "cards"} in the tray
              </p>
              <p className="text-xs text-fg-3">
                Market <Money pence={trayTotal(lines)} size="sm" className="font-bold text-fg" tween />
              </p>
            </div>
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? "Hide the tray" : "Show the tray"} className="flex size-10 items-center justify-center rounded-full text-fg-2 hover:bg-line">
              {open ? <ChevronDown className="size-5" aria-hidden /> : <ChevronUp className="size-5" aria-hidden />}
            </button>
          </div>

          {open && (
            <ul className="mt-3 flex max-h-56 flex-col divide-y divide-line overflow-y-auto border-t border-line">
              {lines.map((line) => (
                <li key={`${line.card.id}-${line.condition}`} className="flex items-center gap-3 py-2">
                  <CardImage src={line.card.image_small} alt="" width={28} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{line.card.name}</p>
                    <p className="truncate text-[11px] text-fg-3">
                      {line.card.set_name} · <span className="font-mono tnum">{numberLabel(line.card)}</span> · {line.condition}
                      {line.qty > 1 ? ` × ${line.qty}` : ""}
                    </p>
                  </div>
                  {line.pence != null ? <Money pence={line.pence * line.qty} size="sm" className="font-bold" /> : <span className="text-xs text-fg-3">No price</span>}
                  <button type="button" onClick={() => onChange(removeLine(lines, line.card.id, line.condition))} aria-label={`Remove one ${line.card.name} ${line.condition}`} className="flex size-9 items-center justify-center rounded-full text-fg-2 hover:bg-line">
                    <Minus className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
            <Button size="sm" icon={<Handshake className="size-4" aria-hidden />} onClick={() => void navigate({ href: addManyToDealHref(dealId, trayUnits(lines)) })}>
              {dealId ? "Add all to deal" : "Add all to deal"}
            </Button>
            <Button size="sm" variant="secondary" icon={<PackagePlus className="size-4" aria-hidden />} loading={adding} onClick={() => void toStock()}>
              Add all to stock
            </Button>
            <Button size="sm" variant="ghost" aria-label="Empty the tray" onClick={() => onChange([])} className="px-2.5">
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
