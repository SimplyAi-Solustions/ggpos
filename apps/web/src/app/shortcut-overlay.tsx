/**
 * The keyboard shortcuts, drawn rather than described.
 *
 * `?` opens it from anywhere on the counter, Esc closes it, and it is in the
 * command palette for anybody who reaches for the mouse instead. The list is
 * `app/shortcuts.ts` itself, so a key that is added to the counter and not
 * to this page cannot happen.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { MicroLabel } from "@/components/ui/micro-label"
import { ESC_LINE, SHORTCUT_GROUPS, SHORTCUTS } from "@/app/shortcuts"

export interface ShortcutOverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutOverlay({ open, onOpenChange }: ShortcutOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcut-overlay" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            None of these fire while the caret is in a field, so a scanner can
            never set one off.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-8">
          {SHORTCUT_GROUPS.map((group) => {
            const keys = SHORTCUTS.filter((shortcut) => shortcut.group === group)
            if (keys.length === 0) return null
            return (
              <div key={group}>
                <MicroLabel className="mb-3">{group}</MicroLabel>
                <ul className="flex flex-col">
                  {keys.map((shortcut) => (
                    <li
                      key={shortcut.keys}
                      className="flex items-center justify-between gap-6 border-b border-hairline-soft py-2.5 last:border-b-0"
                    >
                      <span className="text-[15px] text-foreground">
                        {shortcut.label}
                      </span>
                      <Kbd>{shortcut.keys}</Kbd>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        <p className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground-2">
          <Kbd>Esc</Kbd>
          {ESC_LINE}
        </p>
      </DialogContent>
    </Dialog>
  )
}
