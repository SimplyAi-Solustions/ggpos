/**
 * The item page's Website row (docs/api-contract-launch.md, section 6): a
 * switch for `show_online`, its state in words beside it, and one grey line
 * under it saying whether the website shows the item right now and, when it
 * does not, why.
 *
 * "Right now" is the public feed's own answer for this code, so what the
 * counter reads is what a visitor sees. The reason is the shared rule
 * (`onlineProblem`) with the shop's settings when an admin can read them;
 * anybody else gets the same rule with the defaults, and a line that names
 * the two settings that could be in the way.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DEFAULT_ONLINE_SETTINGS, onlineProblem } from "@gg/shared"

import { MicroLabel } from "@/components/ui/micro-label"
import { Switch } from "@/components/ui/switch"
import { useStaffRole } from "@/features/lock/role"
import { isOnWebsite, ONLINE_FEED_KEY, setItemsOnline, useOnlineSettings } from "@/lib/api/online"
import { refusalOrFallback } from "@/lib/api/refusal"
import type { ItemDetail } from "@/lib/api/types"

export function WebsiteRow({ item, onChanged }: { item: ItemDetail; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const admin = useStaffRole() === "admin"
  const settings = useOnlineSettings(admin)
  const shown = item.show_online === true

  const live = useQuery({
    queryKey: [...ONLINE_FEED_KEY, "item", item.sku, item.updated ?? ""],
    queryFn: () => isOnWebsite(item.sku),
    enabled: shown,
    staleTime: 15_000,
  })

  const toggle = useMutation({
    mutationFn: (next: boolean) => setItemsOnline([item.id], next),
    onSuccess: () => {
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ONLINE_FEED_KEY })
    },
  })

  const rule = settings.data ?? DEFAULT_ONLINE_SETTINGS
  const reason = onlineProblem(
    { show_online: shown, status: item.status, qty: item.qty, price: item.price },
    rule
  )

  let line: string
  if (toggle.error) {
    line = refusalOrFallback(toggle.error, "That did not save. Check the connection and try again.")
  } else if (!shown) {
    line = "Not on the website. Switch it on to list it."
  } else if (live.isPending) {
    line = "Checking the website."
  } else if (live.data) {
    line = "On the website now."
  } else {
    line =
      reason ??
      "Not on the website: under the website's minimum price, or the website is switched off in Settings."
  }

  return (
    <div className="border-b border-hairline-soft py-3" data-testid="item-website">
      <div className="flex min-h-12 items-center justify-between gap-6">
        <MicroLabel>Website</MicroLabel>
        <span className="flex items-center gap-4">
          <span className="text-[15px] text-foreground" data-testid="item-website-state">
            {shown ? "Shown online" : "Not online"}
          </span>
          <Switch
            checked={shown}
            disabled={toggle.isPending}
            onCheckedChange={(next: boolean) => toggle.mutate(next)}
            aria-label="Show on the website"
          />
        </span>
      </div>
      <p
        aria-live="polite"
        data-testid="item-website-note"
        className={
          toggle.error
            ? "max-w-[56ch] text-[13px] leading-[1.45] text-destructive"
            : "max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2"
        }
      >
        {line}
      </p>
    </div>
  )
}
