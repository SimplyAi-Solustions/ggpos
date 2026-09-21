/**
 * A scanned GGV code, and what can be done with it.
 *
 * Which action shows is decided by `vouchers.ts` from the type and the
 * state, not by this component: a money-off reward is spent on a basket at
 * Sell, a free item or an event entry is marked used here, store credit was
 * already paid out when it was redeemed, and only an admin can cancel one
 * and put the points back.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { MicroLabel } from "@/components/ui/micro-label"
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
import { formatShortDate } from "@/features/customers/format"
import {
  voucherActions,
  voucherStatusWord,
  voucherWorth,
} from "@/features/loyalty/vouchers"
import { cancelVoucher, getVoucherByCode, markVoucherUsed } from "@/lib/api/loyalty"
import { refusalOrFallback } from "@/lib/api/refusal"
import { useStaff } from "@/lib/auth"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3 first:border-t">
      <MicroLabel>{label}</MicroLabel>
      <span className="text-[15px] text-foreground">{children}</span>
    </div>
  )
}

export interface VoucherSheetProps {
  /** The scanned code, or null when the sheet is closed. */
  code: string | null
  onOpenChange: (open: boolean) => void
}

export function VoucherSheet({ code, onOpenChange }: VoucherSheetProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isAdmin = useStaff()?.role === "admin"
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  const { data: voucher, isPending } = useQuery({
    queryKey: ["voucher", code],
    queryFn: () => getVoucherByCode(code as string),
    enabled: Boolean(code),
  })

  function settle() {
    void queryClient.invalidateQueries({ queryKey: ["voucher", code] })
    void queryClient.invalidateQueries({ queryKey: ["customer-guild"] })
  }

  const markUsed = useMutation({
    mutationFn: () => markVoucherUsed(code as string),
    onSuccess: () => {
      setError(null)
      setDone("Marked used. Hand it over.")
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That voucher was not marked used.")),
  })

  const cancel = useMutation({
    mutationFn: () => cancelVoucher(code as string),
    onSuccess: (result) => {
      setError(null)
      setDone(`Cancelled. The points are back on ${result.customer.name}'s account.`)
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That voucher was not cancelled.")),
  })

  const actions = voucher
    ? voucherActions(voucher, { admin: Boolean(isAdmin) })
    : { sell: false, markUsed: false, cancel: false, note: "" }

  return (
    <Sheet
      open={code !== null}
      onOpenChange={(open: boolean) => {
        onOpenChange(open)
        if (!open) {
          setError(null)
          setDone(null)
        }
      }}
    >
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Voucher</SheetTitle>
          <SheetDescription>
            {code ? displayCode(code) : ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {isPending ? <SkeletonText lines={4} /> : null}

          {!isPending && !voucher ? (
            <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
              No voucher has that code. Check it, or look the customer up and
              read it off their rewards.
            </p>
          ) : null}

          {voucher ? (
            <div data-testid="voucher-sheet">
              <Row label="Reward">{voucher.rewardName}</Row>
              <Row label="Worth">{voucherWorth(voucher.type, voucher.value)}</Row>
              <Row label="Customer">
                <Link
                  to="/counter/customers/$code"
                  params={{ code: voucher.customer.code }}
                  className="underline-offset-4 outline-none hover:underline"
                  onClick={() => onOpenChange(false)}
                >
                  {voucher.customer.name}
                </Link>
              </Row>
              <Row label="Status">
                <span data-testid="voucher-status">
                  <Badge variant="outline">{voucherStatusWord(voucher.status)}</Badge>
                </span>
              </Row>
              <Row label="Expires">
                <span className="tnum">
                  {voucher.expiresAt ? formatShortDate(voucher.expiresAt) : "No expiry"}
                </span>
              </Row>
              {actions.note ? (
                <p className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                  {actions.note}
                </p>
              ) : null}
              {done ? (
                <p
                  role="status"
                  className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-foreground"
                >
                  {done}
                </p>
              ) : null}
            </div>
          ) : null}
        </SheetBody>
        <SheetFooter>
          {actions.sell ? (
            <Button
              type="button"
              trailingArrow
              onClick={() => {
                onOpenChange(false)
                void navigate({
                  to: "/counter/sell",
                  search: { voucher: voucher?.code ?? "" },
                })
              }}
            >
              Use on a sale
            </Button>
          ) : null}
          {actions.markUsed ? (
            <Button
              type="button"
              trailingArrow
              loading={markUsed.isPending}
              disabled={Boolean(done)}
              onClick={() => markUsed.mutate()}
            >
              Mark as used
            </Button>
          ) : null}
          {actions.cancel ? (
            <Button
              variant="text-destructive"
              type="button"
              loading={cancel.isPending}
              disabled={Boolean(done)}
              onClick={() => cancel.mutate()}
            >
              Cancel and return the points
            </Button>
          ) : null}
          <Button variant="text" type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {error ? <FieldError>{error}</FieldError> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
