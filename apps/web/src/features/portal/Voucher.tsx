import { Link } from "@tanstack/react-router"
import { displayCode, encodeCode, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { QrCode } from "@/features/customers/GuildCard"
import { formatDate } from "@/features/portal/format"
import { rewardWorth, voucherIsLive, voucherStatusWord } from "@/features/portal/guild"
import { Note } from "@/features/portal/Note"
import type { PortalVoucher } from "@/lib/api/guild"

/**
 * A redeemed reward, as the customer shows it at the counter.
 *
 * The QR is the same component the Guild card uses, so bwip-js is loaded
 * once and lazily and the code paints as text on the first frame either
 * way. What it carries is the bare `GGV…` form the counter's scan listener
 * routes on, and the hyphenated form is printed under it so a voucher still
 * works when the screen is too scratched to scan.
 *
 * A store-credit reward has nothing to scan: the money went onto the account
 * the moment it was redeemed, so it says that instead of showing a code
 * nobody can use.
 */
export function VoucherBody({ voucher }: { voucher: PortalVoucher }) {
  const live = voucherIsLive(voucher)
  const status = voucherStatusWord(voucher)
  const worth = rewardWorth(voucher.reward.type, voucher.reward.value)

  if (voucher.reward.type === "store_credit") {
    return (
      <div className="flex flex-col items-start gap-4">
        <MicroLabel tone="ink">{status}</MicroLabel>
        <p className="max-w-[48ch] text-base leading-[1.5] text-foreground">
          {`This one paid ${formatGBP(voucher.reward.value)} of store credit onto your account. There is nothing to show at the counter.`}
        </p>
        {/* The number is a code, so it is set in mono like every other
            reference in My Vault, never in Jost. */}
        <span className="tnum font-mono text-[13px] text-muted-foreground-2">
          {voucher.number}
        </span>
        <Button variant="text" render={<Link to="/account/credit" />}>
          See my credit
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-5">
      <MicroLabel tone="ink">{status}</MicroLabel>

      {live ? (
        <QrCode
          text={encodeCode(voucher.code)}
          title={`Voucher ${displayCode(voucher.code)}`}
          style={{ width: 180, height: 180 }}
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="tnum block font-mono text-[20px] leading-none text-foreground">
          {displayCode(voucher.code)}
        </span>
        <Note>
          <span className="tnum font-mono text-[13px]">{voucher.number}</span>
          {worth ? ` · ${worth}` : null}
        </Note>
      </div>

      {live ? (
        <>
          <p className="text-base leading-[1.5] text-foreground">
            Show this at the counter.
          </p>
          {voucher.expires_at ? (
            <Note>{`Use it before ${formatDate(voucher.expires_at)}.`}</Note>
          ) : null}
        </>
      ) : (
        <Note>
          {voucher.status === "used"
            ? "This one has been used."
            : voucher.status === "cancelled"
              ? "This one was cancelled and the points went back on your account."
              : `This one ran out on ${formatDate(voucher.expires_at)}. The points do not come back.`}
        </Note>
      )}
    </div>
  )
}
