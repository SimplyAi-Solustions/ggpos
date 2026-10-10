/**
 * Reports: the dashboard first (docs/api-contract-launch.md, section 3),
 * then the nine reports one line each, the VAT return and the files.
 *
 * The lists are links rather than a grid of tiles: sections are divided by
 * whitespace and there are no cards in this system, so the row itself is the
 * target and the hairline under it is the only rule on the page.
 */
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { useStaff } from "@/lib/auth"
import { DashboardSection } from "@/features/reports/DashboardScreen"
import { REPORT_ORDER, REPORT_SPECS } from "@/features/reports/specs"

export function ReportsIndexScreen() {
  const admin = useStaff()?.role === "admin"

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Reports</PageTitle>
      <Lede>
        Sales, cost and profit over a range and against the period before it,
        then every report.
      </Lede>

      <DashboardSection />

      <section className="mt-24" aria-labelledby="every-report">
        <SectionHeading id="every-report">Every report</SectionHeading>
        <ul data-testid="report-list">
          {REPORT_ORDER.map((key) => {
            const spec = REPORT_SPECS[key]
            return (
              <li key={key} className="border-b border-hairline-soft first:border-t">
                <Link
                  to="/counter/reports/$key"
                  params={{ key }}
                  className="flex min-h-16 items-center justify-between gap-6 py-4 transition-colors duration-150 ease-gg hover:bg-row-hover"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-base text-foreground">{spec.title}</span>
                    <span className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                      {spec.lede}
                    </span>
                  </span>
                  {spec.admin ? (
                    <MicroLabel tone="hint" className="shrink-0">
                      {admin ? "Admin" : "Admins only"}
                    </MicroLabel>
                  ) : null}
                </Link>
              </li>
            )
          })}
        </ul>
      </section>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          VAT
        </MicroLabel>
        <ul data-testid="vat-list">
          <li className="border-b border-hairline-soft first:border-t">
            <Link
              to="/counter/reports/vat"
              className="flex min-h-16 items-center justify-between gap-6 py-4 transition-colors duration-150 ease-gg hover:bg-row-hover"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-base text-foreground">VAT return</span>
                <span className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                  The nine boxes for a quarter, the margin scheme working and the sales behind them.
                </span>
              </span>
            </Link>
          </li>
        </ul>
      </div>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Files
        </MicroLabel>
        <p className="mb-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          The eBay listing file, the inventory and sales exports, and the
          Card Uploader and eBay orders imports.
        </p>
        <Button variant="text" render={<Link to="/counter/exports" />}>
          Exports and imports
        </Button>
      </div>
    </section>
  )
}
