import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { ProductImage } from "@/components/product-image"
import { listRewards, redeemReward, type PortalVoucher } from "@/lib/api/guild"
import { getMe } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"
import { usePortalDock } from "@/features/portal/dock"
import {
  descriptionParagraphs,
  formatPoints,
  rewardReasonSentence,
  rewardWorth,
} from "@/features/portal/guild"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import { VoucherBody } from "@/features/portal/Voucher"

/**
 * One reward, and the one thing to do with it.
 *
 * Redeeming spends points that do not come back, so it goes through a sheet
 * that says what it will cost and what will be left, and the same sheet then
 * becomes the voucher: the code is the whole point of having pressed the
 * button, and sending somebody to another screen to find it would be the
 * moment to lose it.
 */
export function RewardDetailScreen({ id }: { id: string }) {
  const dock = usePortalDock()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)
  const [issued, setIssued] = React.useState<PortalVoucher | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const rewards = useQuery({ queryKey: ["portal", "rewards"], queryFn: listRewards })

  const redeem = useMutation({
    mutationFn: () => redeemReward(id),
    onSuccess: async (voucher) => {
      setIssued(voucher)
      setError(null)
      // The balance, the catalogue and the voucher list all move together.
      await queryClient.invalidateQueries({ queryKey: ["portal"] })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That did not go through. Try again in a moment.")
      ),
  })

  if (me.isError || rewards.isError) {
    return (
      <LoadFailed
        title="Reward"
        error={rewards.error ?? me.error}
        fallback="We could not read that reward just now. Check your connection and try again."
        onRetry={() => {
          void me.refetch()
          void rewards.refetch()
        }}
      />
    )
  }

  if (rewards.isPending) {
    return (
      <section className="pt-12 sm:pt-20">
        <SkeletonText lines={6} />
      </section>
    )
  }

  const reward = (rewards.data ?? []).find((row) => row.id === id)

  if (!reward) {
    // A reward taken out of the catalogue while this screen was open. If a
    // voucher was issued first, it is shown here rather than lost with the
    // sheet: the code is the thing the customer has paid points for.
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>{issued ? issued.reward.name : "Reward"}</PageTitle>
        {issued ? (
          <div className="mt-10">
            <VoucherBody voucher={issued} />
          </div>
        ) : (
          <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
            That reward is not in the catalogue any more. Have a look at what
            is in it now.
          </p>
        )}
        <div className="mt-10">
          <Button variant="text" render={<Link to="/account/rewards" />}>
            Back to rewards
          </Button>
        </div>
      </section>
    )
  }

  const points = me.data?.balances.points ?? 0
  const refusal = rewardReasonSentence(reward, points)
  const worth = rewardWorth(reward.type, reward.value)
  const paragraphs = descriptionParagraphs(reward.description_html)
  const left = points - reward.cost_points

  function closeSheet() {
    setConfirming(false)
    setError(null)
    // The voucher stays on the vouchers list; this sheet starts clean.
    setIssued(null)
  }

  const primary = (
    <Button
      type="button"
      trailingArrow
      onClick={() => {
        setError(null)
        setIssued(null)
        setConfirming(true)
      }}
    >
      {`Redeem for ${formatPoints(reward.cost_points)} points`}
    </Button>
  )

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>{reward.name}</PageTitle>

      <div className="mt-10">
        <ProductImage
          src={reward.image_url}
          alt={reward.name}
          ratio={[4, 3]}
          finish="edge"
          width={260}
          priority
        />
      </div>

      <div className="mt-10 flex flex-col gap-1.5">
        <MicroLabel>Cost</MicroLabel>
        <span
          data-testid="reward-cost"
          className="tnum text-[20px] leading-none font-medium"
        >
          {`${formatPoints(reward.cost_points)} points`}
        </span>
        {worth ? <Note className="mt-1">{worth}</Note> : null}
      </div>

      {paragraphs.length > 0 ? (
        <div className="mt-10 flex flex-col gap-4">
          {paragraphs.map((paragraph, index) => (
            <p
              key={index}
              className="max-w-[56ch] text-base leading-[1.5] text-muted-foreground"
            >
              {paragraph}
            </p>
          ))}
        </div>
      ) : null}

      {reward.remaining !== null ? (
        <Note className="mt-8">
          {reward.remaining === 1
            ? "1 left."
            : `${formatPoints(reward.remaining)} left.`}
        </Note>
      ) : null}

      <Note className="mt-3">
        Use a voucher before the date on it. An expired voucher cannot be
        swapped back for points, and no reward is exchangeable for cash.
      </Note>

      {refusal ? (
        // Ink, not a grey hint: this is the answer to the only question the
        // screen is here to settle.
        <p
          data-testid="reward-refusal"
          className="mt-10 max-w-[48ch] text-base leading-[1.5] text-foreground"
        >
          {refusal}
        </p>
      ) : (
        <div className="mt-12 hidden min-[900px]:block">{primary}</div>
      )}

      <div className="mt-14">
        <Button variant="text" render={<Link to="/account/rewards" />}>
          Back to rewards
        </Button>
      </div>

      {!refusal && dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}

      <Sheet
        open={confirming}
        onOpenChange={(next) => {
          if (!next) closeSheet()
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className={SHEET_COLUMN}>
            <SheetTitle>{issued ? "Your voucher" : "Redeem this reward"}</SheetTitle>
            {issued ? null : (
              <SheetDescription>
                {`${reward.name} costs ${formatPoints(reward.cost_points)} points. You would have ${formatPoints(Math.max(0, left))} left.`}
              </SheetDescription>
            )}
          </SheetHeader>
          <SheetBody className={SHEET_COLUMN}>
            {issued ? (
              <VoucherBody voucher={issued} />
            ) : (
              <p className="max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
                {reward.type === "store_credit"
                  ? `The ${worth} goes onto your account straight away. Points spent on a reward do not come back.`
                  : "You get a voucher with a code to show at the counter. Points spent on a reward do not come back."}
              </p>
            )}
            {error ? <FieldError className="mt-8">{error}</FieldError> : null}
          </SheetBody>
          <SheetFooter className={SHEET_COLUMN}>
            {issued ? (
              <Button type="button" variant="text" onClick={closeSheet}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  trailingArrow
                  loading={redeem.isPending}
                  onClick={() => redeem.mutate()}
                >
                  Redeem
                </Button>
                <Button type="button" variant="text" onClick={closeSheet}>
                  Cancel
                </Button>
              </>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
