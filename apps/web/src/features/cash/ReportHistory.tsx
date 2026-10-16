/**
 * The X and Z reports already run, newest first, with reprint behind each
 * one (docs/api-contract-epos.md, section 3, `GET /api/vault/till/reports`).
 *
 * Reading them is the `x_report` capability. A member of staff whose role
 * lacks it is not shown a dialog they did not ask for when the screen
 * opens: the list says so in a line and offers to ask a manager.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { SkeletonText } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { varianceWords } from "@/features/cash/count"
import { reportTitle } from "@/features/cash/report-lines"
import { OverrideCancelled, neededCapability, withOverride } from "@/features/lock/override"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listTillReports, type ReportPage } from "@/lib/api/tillops"
import { REPORTS_KEY } from "@/features/cash/keys"
import { formatDateTime } from "@/lib/dates"
import type { TillReportSummary } from "@gg/shared"


function cashLine(row: TillReportSummary): string {
  return row.type === "z" ? varianceWords(row.cash_variance) : ""
}

function cardLine(row: TillReportSummary): string {
  return row.type === "z" && row.card_variance !== null ? varianceWords(row.card_variance) : ""
}

export function ReportHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const reports = useQuery({
    queryKey: REPORTS_KEY,
    queryFn: () => listTillReports({ perPage: 20 }),
    staleTime: 15_000,
    retry: false,
  })
  // An approval is spent on the one read it was given for, so the list it
  // brought back is kept as it came rather than read again without it.
  const [approved, setApproved] = React.useState<ReportPage | null>(null)
  const [askError, setAskError] = React.useState<string | null>(null)
  const needsApproval = !approved && neededCapability(reports.error) !== null

  async function ask() {
    setAskError(null)
    try {
      setApproved(
        await withOverride((headers) => listTillReports({ perPage: 20 }, headers), {
          describe: () => "See past X and Z reports",
        })
      )
    } catch (cause) {
      if (cause instanceof OverrideCancelled) return
      setAskError(refusalOrFallback(cause, "The reports would not load. Try again."))
    }
  }

  const rows = (approved ?? reports.data)?.items ?? []

  return (
    <section className="mt-24" aria-labelledby="till-reports-heading">
      <h2 id="till-reports-heading" className="mb-5">
        <MicroLabel tone="ink">Reports</MicroLabel>
      </h2>
      {reports.isPending && !approved ? (
        <SkeletonText lines={3} className="max-w-[420px]" />
      ) : needsApproval ? (
        <div className="flex flex-col items-start gap-4">
          <p className="text-[15px] leading-[1.5] text-muted-foreground">
            Past reports need a manager. Ask one to approve it here.
          </p>
          <Button variant="text" onClick={() => void ask()}>
            Ask a manager
          </Button>
          {askError ? (
            <p role="alert" className="text-[13px] text-destructive">
              {askError}
            </p>
          ) : null}
        </div>
      ) : reports.error && !approved ? (
        <p role="alert" className="text-[15px] text-destructive">
          {refusalOrFallback(reports.error, "The reports would not load. Check the connection and try again.")}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[15px] text-muted-foreground-2">No X or Z report has been run yet.</p>
      ) : (
        <>
          <div className="hidden min-[900px]:block">
            <Table data-testid="report-history">
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead numeric>Net</TableHead>
                  <TableHead>Cash</TableHead>
                  <TableHead>Card</TableHead>
                  <TableHead>
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid="report-row">
                    <TableCell className="font-medium">{reportTitle(row)}</TableCell>
                    <TableCell className="tnum font-mono text-[13px]">
                      {formatDateTime(row.created)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.created_by_name}</TableCell>
                    <TableCell numeric>{formatGBP(row.net)}</TableCell>
                    <TableCell>{cashLine(row)}</TableCell>
                    <TableCell>{cardLine(row)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="text"
                        aria-label={`Open ${reportTitle(row)}`}
                        onClick={() => onOpen(row.id)}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="min-[900px]:hidden" data-testid="report-history-small">
            {rows.map((row) => (
              <li key={row.id} className="border-b border-hairline-soft first:border-t">
                <button
                  type="button"
                  onClick={() => onOpen(row.id)}
                  aria-label={`Open ${reportTitle(row)}`}
                  className="flex min-h-14 w-full items-center justify-between gap-4 py-3 text-left"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-[15px] font-medium text-foreground">{reportTitle(row)}</span>
                    <span className="truncate text-[13px] text-muted-foreground-2">
                      {formatDateTime(row.created)}, {row.created_by_name}
                      {cashLine(row) ? `. Cash ${cashLine(row).toLowerCase()}` : ""}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-[15px] text-foreground">{formatGBP(row.net)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
