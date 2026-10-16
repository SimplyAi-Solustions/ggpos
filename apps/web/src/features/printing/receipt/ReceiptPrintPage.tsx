/**
 * `/print/receipt/$id` - the browser print page for a receipt, at 80 mm.
 *
 * The fallback for a register with no network printer
 * (docs/api-contract-epos.md, section 6): the same image the Star printer
 * would be sent, drawn by the same renderer, shown at the width of an 80 mm
 * roll and handed to the browser's print dialog. A counter with only a
 * USB or Wi-Fi receipt printer on the Mac prints from here, so what comes out
 * is identical to the network printer's.
 *
 * The page is sized to the receipt: `@page` is 80 mm wide and exactly as
 * tall as the image, so a roll printer's driver feeds the length of the
 * receipt and no more. The image is 72 mm wide inside 4 mm margins, which is
 * the printable width of an 80 mm roll (576 dots at 8 dots a millimetre).
 *
 * In demo mode the receipt is the sample one, so screenshots and the
 * end-to-end suite have something to look at.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import { getReceipt, printingMessage } from "@/lib/api/printing"

/** An 80 mm roll prints 72 mm across: 576 dots at 8 dots a millimetre. */
const PRINTABLE_MM = 72
const DOTS = 576

/** What arrived, and for which receipt, so a change of receipt reads as loading again. */
type Settled =
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ready"; url: string; number: string; heightMm: number }
type State = Settled | { status: "loading" }

export interface ReceiptPrintPageProps {
  saleId: string
  gift?: boolean
  /** A refund's reference, to print its receipt instead of the sale's. */
  refundRef?: string
  /** Tells the server this is a second copy so it can be logged. */
  reprint?: boolean
  /** `false` holds the print dialog back, for screenshots and tests. */
  autoPrint?: boolean
}

export function ReceiptPrintPage({
  saleId,
  gift = false,
  refundRef = "",
  reprint = false,
  autoPrint = true,
}: ReceiptPrintPageProps) {
  const requestKey = `${saleId}|${gift}|${refundRef}|${reprint}`
  const [settled, setSettled] = React.useState<Settled | null>(null)
  // Whatever arrived for an earlier receipt is not this one's answer.
  const state: State = settled && settled.key === requestKey ? settled : { status: "loading" }

  React.useEffect(() => {
    let cancelled = false
    let url = ""
    void (async () => {
      try {
        const receipt = await getReceipt({ saleId, gift, refundRef, reprint })
        const { renderReceiptImage } = await import("@/features/printing/receipt/render")
        const blob = await renderReceiptImage(receipt, { width: DOTS, gift })
        if (cancelled) return
        url = URL.createObjectURL(blob)
        const dots = await imageHeight(url)
        setSettled({
          key: requestKey,
          status: "ready",
          url,
          number: receipt.number,
          heightMm: Math.ceil((dots / DOTS) * PRINTABLE_MM) + 2,
        })
      } catch (error) {
        if (cancelled) return
        setSettled({
          key: requestKey,
          status: "error",
          message: printingMessage(
            error,
            "The receipt could not be drawn. Check you are signed in, then try again from the sale."
          ),
        })
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [saleId, gift, refundRef, reprint, requestKey])

  // The dialog opens once, when the image is on the page.
  const printed = React.useRef(false)
  const onLoad = React.useCallback(() => {
    if (!autoPrint || printed.current) return
    printed.current = true
    window.print()
  }, [autoPrint])

  if (state.status === "error") {
    return (
      <main className="mx-auto w-full max-w-[1040px] px-5 pt-24 sm:px-10">
        <p role="alert" data-testid="receipt-error" className="text-base text-destructive">
          {state.message}
        </p>
      </main>
    )
  }

  if (state.status === "loading") {
    return (
      <main className="mx-auto w-full max-w-[1040px] px-5 pt-24 sm:px-10">
        <p className="text-base text-muted-foreground-2">Drawing the receipt.</p>
      </main>
    )
  }

  return (
    <main data-testid="receipt-sheet" className="bg-white text-black">
      <style>{`/* A printed receipt, not a screen: sized in millimetres for an 80 mm roll. */
        @page { size: 80mm ${state.heightMm}mm; margin: 0 }
        html, body { background: #ffffff; margin: 0; padding: 0 }
        body::before { display: none }
        @media screen {
          [data-slot="receipt-image"] { outline: 1px solid rgba(11,11,11,.12); margin: 8px auto }
        }
        @media print {
          [data-slot="receipt-toolbar"] { display: none }
        }`}</style>
      <div
        data-slot="receipt-toolbar"
        className="mx-auto flex w-full max-w-[80mm] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4"
      >
        <span className="text-[15px] text-muted-foreground">Receipt {state.number}</span>
        <span className="flex items-center gap-6">
          <Button variant="text" type="button" onClick={() => window.print()}>
            Print
          </Button>
          <Button variant="text" type="button" onClick={() => window.close()}>
            Close
          </Button>
        </span>
      </div>
      <img
        data-slot="receipt-image"
        data-testid="receipt-image"
        data-gift={gift ? "1" : undefined}
        src={state.url}
        alt={`${gift ? "Gift receipt" : refundRef ? "Refund receipt" : "Receipt"} ${state.number}`}
        width={DOTS}
        onLoad={onLoad}
        style={{ width: `${PRINTABLE_MM}mm`, height: "auto" }}
        className="mx-auto block"
      />
    </main>
  )
}

/** How tall the drawn receipt is, in dots, before it is sized for the page. */
function imageHeight(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Image()
    probe.onload = () => resolve(probe.naturalHeight)
    probe.onerror = () => reject(new Error("The receipt could not be drawn. Try again."))
    probe.src = url
  })
}
