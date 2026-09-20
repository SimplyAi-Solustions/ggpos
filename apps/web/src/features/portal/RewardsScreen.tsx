import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerCards } from "@/components/ui/sticker"
import { ProductImage } from "@/components/product-image"
import { listMyVouchers, listRewards, type PortalVoucher } from "@/lib/api/guild"
import { getMe } from "@/lib/api/portal"
import { formatDate } from "@/features/portal/format"
import {
  formatPoints,
  rewardReasonSentence,
  voucherIsLive,
  voucherStatusWord,
} from "@/features/portal/guild"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import { VoucherBody } from "@/features/portal/Voucher"

/**
 * The rewards catalogue, and the vouchers it has already produced.
 *
 * A row that cannot be redeemed yet says so in a sentence rather than going
 * grey: "You need 500 points and have 320" is the whole answer, and it is
 * the same sentence the server refuses the redeem with. Nothing here is
 * hidden from somebody who cannot afford it, because seeing what the points
 * are for is the reason to earn them.
 */

/** The date line under a voucher, which depends on where it has got to. */
function voucherDateLine(voucher: PortalVoucher): string {
  if (voucherIsLive(voucher) && voucher.expires_at) {
    return `Use it before ${formatDate(voucher.expires_at)}`
  }
  if (voucher.status === "used") {
    return `Redeemed ${formatDate(voucher.created)}`
  }
  if (voucher.status === "cancelled") {
    return "Cancelled, points returned"
  }
  return voucher.expires_at ? `Ran out on ${formatDate(voucher.expires_at)}` : ""
}

export function RewardsScreen() {
  const [showing, setShowing] = React.useState<PortalVoucher | null>(null)

  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const rewards = useQuery({ queryKey: ["portal", "rewards"], queryFn: listRewards })
  const vouchers = useQuery({
    queryKey: ["portal", "vouchers"],
    queryFn: listMyVouchers,
  })

  if (me.isError || rewards.isError || vouchers.isError) {
    return (
      <LoadFailed
        title="Rewards"
        error={rewards.error ?? vouchers.error ?? me.error}
        fallback="We could not read the rewards just now. Check your connection and try again."
        onRetry={() => {
          void me.refetch()
          void rewards.refetch()
          void vouchers.refetch()
        }}
      />
    )
  }

  const points = me.data?.balances.points ?? 0
  const rows = rewards.data ?? []
  const myVouchers = vouchers.data ?? []

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Rewards</PageTitle>
      <Lede>Spend your points on something out of the shop.</Lede>

      <div className="mt-12 flex flex-col gap-1.5">
        <MicroLabel>Your points</MicroLabel>
        {me.isPending ? (
          <SkeletonText lines={1} />
        ) : (
          <span
            data-testid="rewards-points"
            className="tnum text-[20px] leading-none font-medium"
          >
            {formatPoints(points)}
          </span>
        )}
      </div>

      {rewards.isPending ? (
        <div className="mt-12">
          <SkeletonText lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerCards className="size-14 shrink-0" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing in the catalogue at the moment. Your points keep counting,
            and rewards come back in before every event.
          </p>
        </div>
      ) : (
        <ul data-testid="reward-list" className="mt-12 flex flex-col">
          {rows.map((reward) => {
            const refusal = rewardReasonSentence(reward, points)
            return (
              <li key={reward.id} className="border-b border-hairline-soft">
                <Link
                  to="/account/rewards/$id"
                  params={{ id: reward.id }}
                  data-testid="reward-row"
                  className="flex min-h-16 items-center gap-4 py-4 transition-colors duration-150 ease-gg hover:bg-row-hover"
                >
                  <ProductImage
                    src={reward.image_url}
                    alt=""
                    ratio={[4, 3]}
                    finish="edge"
                    height={48}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-[15px] leading-[1.35] text-foreground">
                      {reward.name}
                    </span>
                    {refusal ? <Note>{refusal}</Note> : null}
                  </span>
                  <span className="tnum shrink-0 text-[15px] font-medium">
                    {`${formatPoints(reward.cost_points)} points`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <SectionHeading className="mt-16">My vouchers</SectionHeading>
      {vouchers.isPending ? (
        <SkeletonText lines={3} />
      ) : myVouchers.length === 0 ? (
        <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
          Nothing redeemed yet. A reward you redeem turns into a voucher here,
          with a code to show at the counter.
        </p>
      ) : (
        <ul data-testid="voucher-list" className="flex flex-col">
          {myVouchers.map((voucher) => {
            const live = voucherIsLive(voucher)
            return (
              <li
                key={voucher.id}
                data-testid="voucher-row"
                className="flex items-center justify-between gap-4 border-b border-hairline-soft py-4"
              >
                <span className="flex min-w-0 flex-col gap-1.5">
                  <MicroLabel tone="ink">{voucherStatusWord(voucher)}</MicroLabel>
                  <span className="text-[15px] leading-[1.35] text-foreground">
                    {voucher.reward.name}
                  </span>
                  <Note>{voucherDateLine(voucher)}</Note>
                </span>
                {live ? (
                  <Button
                    type="button"
                    variant="text"
                    className="shrink-0"
                    onClick={() => setShowing(voucher)}
                  >
                    Show code
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <Sheet
        open={showing !== null}
        onOpenChange={(next) => {
          if (!next) setShowing(null)
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className={SHEET_COLUMN}>
            <SheetTitle>{showing?.reward.name ?? "Voucher"}</SheetTitle>
          </SheetHeader>
          <SheetBody className={SHEET_COLUMN}>
            {showing ? <VoucherBody voucher={showing} /> : null}
          </SheetBody>
          <SheetFooter className={SHEET_COLUMN}>
            <Button type="button" variant="text" onClick={() => setShowing(null)}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
