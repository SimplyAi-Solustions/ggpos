/**
 * What can be done with a scanned voucher, by its type and its state.
 *
 * Pure, because the answer decides what the sheet on the Scan screen offers
 * and the sentence it shows when it offers nothing: a money-off reward is
 * spent on a basket at Sell, the other kinds are marked used at the counter,
 * store credit was already paid out when it was redeemed, and only an admin
 * can cancel one and put the points back.
 */
import { formatGBP } from "@gg/shared"

import type { RewardType, VoucherDetail, VoucherStatus } from "@/lib/api/types"

export interface VoucherActions {
  /** Open Sell with this code on the basket. `money_off` only. */
  sell: boolean
  /** POST /api/vault/vouchers/:code/use. */
  markUsed: boolean
  /** POST /api/vault/vouchers/:code/cancel, admin only. */
  cancel: boolean
  /** One sentence for when nothing can be done with it, or "". */
  note: string
}

const STATUS_WORD: Record<VoucherStatus, string> = {
  issued: "Open",
  used: "Used",
  expired: "Expired",
  cancelled: "Cancelled",
}

export function voucherStatusWord(status: VoucherStatus): string {
  return STATUS_WORD[status] ?? status
}

export function isExpired(
  voucher: Pick<VoucherDetail, "expiresAt">,
  now: Date = new Date()
): boolean {
  if (!voucher.expiresAt) return false
  const at = new Date(voucher.expiresAt).getTime()
  return !Number.isNaN(at) && at < now.getTime()
}

/** What the voucher is worth, in words, under its name. */
export function voucherWorth(type: RewardType, value: number): string {
  switch (type) {
    case "money_off":
      return `${formatGBP(value)} off a sale`
    case "store_credit":
      return `${formatGBP(value)} of store credit`
    case "free_item":
      return "One free item"
    case "event_entry":
      return "One event entry"
    default:
      return "Ask the customer what they are claiming"
  }
}

export function voucherActions(
  voucher: Pick<VoucherDetail, "type" | "status" | "expiresAt">,
  options: { admin: boolean; now?: Date }
): VoucherActions {
  const now = options.now ?? new Date()
  const nothing = { sell: false, markUsed: false, cancel: false }

  if (voucher.status !== "issued") {
    return {
      ...nothing,
      note:
        voucher.status === "used"
          ? "This voucher has already been used."
          : voucher.status === "expired"
            ? "This voucher has expired. The points are not coming back."
            : "This voucher was cancelled and its points were returned.",
    }
  }

  if (isExpired(voucher, now)) {
    return { ...nothing, note: "This voucher is past its expiry date." }
  }

  if (voucher.type === "store_credit") {
    return {
      ...nothing,
      cancel: options.admin,
      note: "The credit went on the account when this was redeemed. Nothing to do here.",
    }
  }

  return {
    sell: voucher.type === "money_off",
    markUsed: voucher.type !== "money_off",
    cancel: options.admin,
    note: "",
  }
}

/** The server's own refusal when `use` is called on a money-off voucher. */
export const MONEY_OFF_REFUSAL = "Use this one on the sale: scan it at Sell."
