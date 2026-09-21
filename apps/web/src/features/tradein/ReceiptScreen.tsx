import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { PrintControls, PrintSheet } from "@/components/print/print-sheet"
import { printPage } from "@/components/print/print"
import { getReceipt } from "@/lib/api"

/** A tracked micro heading inside the printed sheet. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block font-mono text-[8pt] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase">
      {children}
    </span>
  )
}

/**
 * The A4 purchase receipt.
 *
 * This is the shop's margin-scheme record as much as it is the customer's
 * copy, so it carries the seller's name and address, the items, the payout
 * and the signature, and it says how long the record is kept. Everything on
 * it, the money included, comes formatted from the server, so the printed
 * page and the emailed copy can never round differently.
 */
export function ReceiptScreen({ id }: { id: string }) {
  const navigate = useNavigate()
  const { data: receipt, isPending, isError } = useQuery({
    queryKey: ["receipt", id],
    queryFn: () => getReceipt(id),
  })

  if (isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <SkeletonText lines={6} />
      </section>
    )
  }

  if (isError || !receipt) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>No receipt</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          That buy-in has no receipt yet. It may still be a draft.
        </p>
        <div className="mt-10">
          <Button
            type="button"
            trailingArrow
            onClick={() => void navigate({ to: "/counter/trade" })}
          >
            Back to trade
          </Button>
        </div>
      </section>
    )
  }

  const shopLine = [receipt.shop.address, receipt.shop.town, receipt.shop.postcode]
    .filter(Boolean)
    .join(", ")

  return (
    <section className="pt-16 sm:pt-24">
      <PrintSheet size="a4" className="mx-auto w-full max-w-[210mm] text-[10pt]">
        <header className="flex flex-wrap items-start justify-between gap-8 border-b border-hairline pb-6">
          <div>
            <p className="font-mono text-[10pt] leading-none font-bold tracking-[0.28em] text-foreground uppercase">
              {receipt.shop.name || "GG Entertainment"}
            </p>
            {shopLine ? (
              <p className="mt-2 text-[9pt] text-muted-foreground">{shopLine}</p>
            ) : null}
            <p className="mt-1 text-[9pt] text-muted-foreground">
              {[receipt.shop.phone, receipt.shop.email].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="text-right">
            <Label>Buy-in</Label>
            <p className="tnum mt-1 font-mono text-[14pt] leading-none text-foreground">
              {receipt.trade_in.number}
            </p>
            <p className="tnum mt-2 text-[9pt] text-muted-foreground">
              {receipt.trade_in.date_display}
            </p>
          </div>
        </header>

        <section className="mt-8 flex flex-wrap gap-x-16 gap-y-6">
          <div className="min-w-[60mm]">
            <Label>Seller</Label>
            <p className="mt-2 text-[10pt] text-foreground">{receipt.seller.name}</p>
            {receipt.seller.address ? (
              <p className="mt-1 max-w-[70mm] text-[9pt] leading-[1.5] text-muted-foreground">
                {receipt.seller.address}
              </p>
            ) : null}
          </div>
          {receipt.seller.id_type ? (
            <div>
              <Label>Identity</Label>
              <p className="tnum mt-2 text-[9pt] text-muted-foreground">
                {receipt.seller.id_type}
                {receipt.seller.id_last4 ? ` ending ${receipt.seller.id_last4}` : ""}
              </p>
            </div>
          ) : null}
          <div>
            <Label>Bought by</Label>
            <p className="mt-2 text-[9pt] text-muted-foreground">
              {receipt.staff.name || "GG Entertainment"}
            </p>
          </div>
        </section>

        <table className="mt-10 w-full border-collapse text-[10pt]">
          <thead>
            <tr className="border-b border-hairline">
              <th className="py-2 pr-3 pl-0 text-left font-mono text-[8pt] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Item
              </th>
              <th className="py-2 pr-3 text-left font-mono text-[8pt] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Condition
              </th>
              <th className="py-2 pr-3 text-right font-mono text-[8pt] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Qty
              </th>
              <th className="py-2 pr-3 text-right font-mono text-[8pt] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Each
              </th>
              <th className="py-2 pr-0 text-right font-mono text-[8pt] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((line) => (
              <tr key={line.id} className="border-b border-hairline-soft">
                <td className="py-2 pr-3 pl-0 text-foreground">
                  {line.title}
                  {line.finish ? (
                    <span className="text-muted-foreground"> · {line.finish}</span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {line.condition || "-"}
                </td>
                <td className="tnum py-2 pr-3 text-right">{line.qty}</td>
                <td className="tnum py-2 pr-3 text-right">
                  {line.offer_price_display}
                </td>
                <td className="tnum py-2 pr-0 text-right">{line.line_total_display}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-8 flex flex-wrap justify-end gap-x-16 gap-y-4 border-t border-hairline pt-5">
          {receipt.trade_in.payout_cash > 0 ? (
            <div className="text-right">
              <Label>Cash paid</Label>
              <p className="tnum mt-1 text-[12pt] text-foreground">
                {receipt.trade_in.payout_cash_display}
              </p>
            </div>
          ) : null}
          {receipt.trade_in.payout_credit > 0 ? (
            <div className="text-right">
              <Label>Store credit</Label>
              <p className="tnum mt-1 text-[12pt] text-foreground">
                {receipt.trade_in.payout_credit_display}
              </p>
            </div>
          ) : null}
          <div className="text-right">
            <Label>Total paid</Label>
            <p className="tnum mt-1 text-[14pt] text-foreground">
              {receipt.trade_in.payout_total_display ||
                formatGBP(receipt.trade_in.payout_total)}
            </p>
          </div>
        </section>

        <section className="mt-10 flex flex-wrap items-end justify-between gap-10">
          <div>
            <Label>Signed</Label>
            {receipt.signature?.url ? (
              <img
                src={receipt.signature.url}
                alt={`Signature of ${receipt.seller.name}`}
                className="mt-2 h-[22mm] w-auto"
              />
            ) : (
              <div className="mt-2 h-[22mm] w-[70mm] border-b border-hairline" />
            )}
            <p className="mt-2 text-[9pt] text-muted-foreground">
              {receipt.seller.name}
            </p>
          </div>
        </section>

        <footer className="mt-10 border-t border-hairline pt-5">
          <p className="max-w-[150mm] text-[8.5pt] leading-[1.5] text-muted-foreground">
            {receipt.terms}
          </p>
          <p className="mt-3 max-w-[150mm] text-[8.5pt] leading-[1.5] text-muted-foreground-2">
            {receipt.retention_note}
          </p>
        </footer>
      </PrintSheet>

      <PrintControls className="mt-14">
        <Button type="button" trailingArrow onClick={printPage}>
          Print
        </Button>
        <Button
          variant="text"
          type="button"
          onClick={() => void navigate({ to: "/counter/trade" })}
        >
          Back to trade
        </Button>
      </PrintControls>
    </section>
  )
}
