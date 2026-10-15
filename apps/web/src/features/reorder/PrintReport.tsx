/**
 * The supplier call on A4 (docs/api-contract-reorder.md, section 4.2): the
 * figures, the to-order table and the open requests, for the clipboard by
 * the phone. Hidden on screen; while the call is mounted its print rule
 * hides everything else on the page, the way `PrintSheet` does for the
 * customer card, and the screen itself is `print:hidden` so it takes no
 * room on the paper. Ink on white whatever the counter's colour mode.
 */
import { REQUEST_STATUS_LABELS, type ReorderReport } from "@gg/shared"

import { formatDateTime } from "@/lib/dates"
import { formatRange } from "@/features/reports/range"
import { requestWho } from "@/features/reorder/rack"

const PRINT_CSS = `
@page { size: A4; margin: 15mm }
@media print {
  html, body { background: #ffffff !important; }
  body::before { display: none !important; }
  body * { visibility: hidden !important; }
  [data-reorder-print], [data-reorder-print] * { visibility: visible !important; }
  [data-reorder-print] { position: absolute !important; inset: 0 auto auto 0; width: 100%; }
}
`

const CELL = "border-b border-gg-ink/15 py-1.5 pr-3 text-left align-top last:pr-0"
const HEAD = "border-b border-gg-ink/40 py-1.5 pr-3 text-left font-mono text-[9pt] font-bold tracking-[0.12em] uppercase last:pr-0"

export function PrintReport({ report, rep }: { report: ReorderReport; rep: string }) {
  const toOrder = report.lines.filter((line) => line.toOrder > 0)
  const figures: [string, number][] = [
    ["In stock", report.totals.inStock],
    ["Sold", report.totals.sold],
    ["Out of stock", report.totals.outOfStock],
    ["To order", report.totals.toOrder],
    ["Requests", report.totals.openRequests],
  ]

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div data-reorder-print="" data-testid="reorder-print" className="hidden bg-white text-[10.5pt] text-gg-ink print:block">
        <p className="font-display text-[22pt] leading-none tracking-[0.01em] uppercase">{report.supplier.name}</p>
        <p className="mt-2">Supplier call, {formatRange({ from: report.from, to: report.to })}</p>
        {rep ? <p className="tnum mt-1">{rep}</p> : null}

        <dl className="mt-6 grid grid-cols-5 gap-4">
          {figures.map(([label, value]) => (
            <div key={label}>
              <dt className="font-mono text-[8pt] font-bold tracking-[0.12em] uppercase">{label}</dt>
              <dd className="tnum m-0 mt-1 text-[14pt] font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-8 font-mono text-[9pt] font-bold tracking-[0.12em] uppercase">To order</p>
        {toOrder.length === 0 ? (
          <p className="mt-2">Nothing to order. Every product with a target is at or above it.</p>
        ) : (
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr>
                <th className={HEAD}>Code</th>
                <th className={HEAD}>Product</th>
                <th className={`${HEAD} text-right`}>To order</th>
                <th className={`${HEAD} text-right`}>In stock</th>
                <th className={`${HEAD} text-right`}>Keep on shelf</th>
              </tr>
            </thead>
            <tbody>
              {toOrder.map((line) => (
                <tr key={line.key} className="break-inside-avoid">
                  <td className={`${CELL} tnum font-mono`}>{line.supplierCode || line.ean}</td>
                  <td className={CELL}>{line.title}</td>
                  <td className={`${CELL} tnum text-right font-medium`}>{line.toOrder}</td>
                  <td className={`${CELL} tnum text-right`}>{line.inStock}</td>
                  <td className={`${CELL} tnum text-right`}>{line.shelfTarget}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-8 font-mono text-[9pt] font-bold tracking-[0.12em] uppercase">Customer requests</p>
        {report.requests.length === 0 ? (
          <p className="mt-2">No open requests.</p>
        ) : (
          <table className="mt-2 w-full border-collapse">
            <thead>
              <tr>
                <th className={HEAD}>What</th>
                <th className={`${HEAD} text-right`}>Qty</th>
                <th className={HEAD}>Who</th>
                <th className={HEAD}>Phone</th>
                <th className={HEAD}>Status</th>
                <th className={HEAD}>Asked</th>
              </tr>
            </thead>
            <tbody>
              {report.requests.map((request) => {
                const who = requestWho(request)
                return (
                  <tr key={request.id} className="break-inside-avoid">
                    <td className={CELL}>
                      {request.title}
                      {request.notes ? <span className="mt-0.5 block text-[9pt]">{request.notes}</span> : null}
                    </td>
                    <td className={`${CELL} tnum text-right`}>{request.qty}</td>
                    <td className={CELL}>
                      {who.name}
                      {who.code ? <span className="tnum block font-mono text-[9pt]">{who.code}</span> : null}
                    </td>
                    <td className={`${CELL} tnum`}>{request.contactPhone}</td>
                    <td className={CELL}>{REQUEST_STATUS_LABELS[request.status]}</td>
                    <td className={`${CELL} tnum whitespace-nowrap`}>{formatDateTime(request.created)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
