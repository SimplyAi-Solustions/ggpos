/**
 * The nine reports, one line each.
 *
 * A list of links rather than a grid of tiles: sections are divided by
 * whitespace and there are no cards in this system, so the row itself is the
 * target and the hairline under it is the only rule on the page.
 */
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { useStaff } from "@/lib/auth"
import { REPORT_ORDER, REPORT_SPECS } from "@/features/reports/specs"

export function ReportsIndexScreen() {
  const admin = useStaff()?.role === "admin"

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Reports</PageTitle>
      <Lede>
        Sales, buy-ins, margin and stock, each over a date range and against
        the period before it.
      </Lede>

      <ul data-testid="report-list" className="mt-14">
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

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Files
        </MicroLabel>
        <p className="mb-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          The SumUp and eBay files, the inventory and sales exports, and the
          Card Uploader and eBay orders imports.
        </p>
        <Button variant="text" render={<Link to="/counter/exports" />}>
          Exports and imports
        </Button>
      </div>
    </section>
  )
}
