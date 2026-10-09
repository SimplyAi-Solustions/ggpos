/**
 * An X or Z report on screen: a 420px column laid out like the printed
 * receipt (DESIGN.md section 10, "Cashing up"). MicroLabel headings, Jost
 * rows with the figures right-aligned in tabular figures, a hairline
 * between groups, and the variance in words. Print and Back are the
 * actions; a printing failure is one line under them and never stops
 * anything.
 */
import * as React from "react"
import { cn } from "cn"
import type { TillReport } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel, microVariants } from "@/components/ui/micro-label"
import { BLOCKED, DockedPrimary } from "@/features/cash/primary"
import { reportGroups, reportHeader, reportTitle } from "@/features/cash/report-lines"
import { printTillReport } from "@/features/printing/receipt"
import { currentRegisterId } from "@/lib/api/till-session"

export function ReportReceipt({ report }: { report: TillReport }) {
  const groups = reportGroups(report)
  return (
    <article
      data-testid="till-report"
      aria-labelledby="till-report-title"
      className="w-full max-w-[420px]"
    >
      <h2
        id="till-report-title"
        data-testid="till-report-title"
        className={microVariants({ tone: "ink" })}
      >
        {reportTitle(report)}
      </h2>
      <div className="mt-3 flex flex-col gap-1 border-b border-hairline-soft pb-5">
        {reportHeader(report).map((line) => (
          <span key={line} className="text-[13px] leading-[1.45] text-muted-foreground-2">
            {line}
          </span>
        ))}
      </div>
      {groups.map((group) => (
        <section
          key={group.heading}
          aria-label={group.heading}
          className="border-b border-hairline-soft py-5 last:border-b-0"
        >
          <MicroLabel className="mb-3">{group.heading}</MicroLabel>
          <dl className="flex flex-col gap-2">
            {group.lines.map((line, index) => (
              <div
                key={`${line.label}-${index}`}
                className="flex items-baseline justify-between gap-6"
                data-testid={line.testId}
              >
                <dt className="min-w-0">
                  <span
                    className={cn(
                      "block text-[15px] leading-[1.4] text-foreground",
                      line.strong && "font-medium",
                      !line.value && "whitespace-pre-wrap"
                    )}
                  >
                    {line.label}
                  </span>
                  {line.note ? (
                    <span className="block text-[13px] leading-[1.4] text-muted-foreground-2">
                      {line.note}
                    </span>
                  ) : null}
                </dt>
                {line.value ? (
                  <dd
                    className={cn(
                      "tnum shrink-0 text-right text-[15px] leading-[1.4] text-foreground",
                      line.strong && "font-medium"
                    )}
                  >
                    {line.value}
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
        </section>
      ))}
    </article>
  )
}

export function ReportView({ report, onBack }: { report: TillReport; onBack: () => void }) {
  const [printing, setPrinting] = React.useState(false)
  const [printNote, setPrintNote] = React.useState<string | null>(null)

  async function print() {
    setPrinting(true)
    setPrintNote(null)
    try {
      const outcome = await printTillReport({
        reportId: report.id,
        register: currentRegisterId(),
      })
      setPrintNote(outcome.ok ? "Sent to the receipt printer." : outcome.message)
    } catch {
      setPrintNote("The report did not print. Try again, or print it from the history later.")
    } finally {
      setPrinting(false)
    }
  }

  const primary = (
    <Button className={BLOCKED} trailingArrow loading={printing} onClick={() => void print()}>
      Print
    </Button>
  )

  return (
    <div className="mt-12">
      <ReportReceipt report={report} />
      <div className="mt-10 flex flex-wrap items-center gap-8">
        <DockedPrimary>{primary}</DockedPrimary>
        <Button variant="text" onClick={onBack}>
          Back
        </Button>
      </div>
      {printNote ? (
        <p data-testid="print-note" aria-live="polite" className="mt-4 text-[13px] leading-[1.45] text-muted-foreground">
          {printNote}
        </p>
      ) : null}
    </div>
  )
}
