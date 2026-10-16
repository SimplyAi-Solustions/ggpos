/**
 * One line under the header once a newer GG Vault has arrived in this tab
 * (`lib/app-update.ts`): what happened and Reload. Built like the offline
 * strip, and never reloads by itself.
 */
import { Button } from "@/components/ui/button"
import { useAppUpdateReady } from "@/lib/app-update"

export function UpdateStrip() {
  const ready = useAppUpdateReady()
  if (!ready) return null
  return (
    <div className="border-b border-hairline-soft bg-background print:hidden">
      <div
        data-testid="update-strip"
        role="status"
        aria-live="polite"
        className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-x-8 gap-y-1 px-5 py-3 sm:px-10"
      >
        <span className="text-[13px] leading-[1.45] text-foreground">
          GG Vault has been updated. Reload to use the new version.
        </span>
        <Button variant="text" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  )
}
