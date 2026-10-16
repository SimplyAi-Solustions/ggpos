import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ReceiptPrintPage } from "@/features/printing/receipt/ReceiptPrintPage"

const searchSchema = z.object({
  /** 1 for a gift receipt: words and quantities, no prices. */
  gift: z.coerce.number().default(0),
  /** A refund's reference, e.g. GG-S-000456-R1, to print its receipt. */
  refund: z.string().default(""),
  /** 1 when this is a second copy, so the server logs it. */
  reprint: z.coerce.number().default(0),
  /** 0 holds the print dialog back, for screenshots and the e2e suite. */
  print: z.coerce.number().default(1),
})

function PrintReceipt() {
  const { id } = Route.useParams()
  const { gift, refund, reprint, print } = Route.useSearch()
  return (
    <ReceiptPrintPage
      saleId={id}
      gift={gift === 1}
      refundRef={refund}
      reprint={reprint === 1}
      autoPrint={print !== 0}
    />
  )
}

export const Route = createFileRoute("/print/receipt/$id")({
  validateSearch: searchSchema,
  component: PrintReceipt,
})
