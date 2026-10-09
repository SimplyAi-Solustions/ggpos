/**
 * Cashing up (docs/api-contract-epos.md, section 3; DESIGN.md section 10,
 * "Cashing up"), in the counter's normal column, not full-bleed, so it
 * reads like the rest of the counter's records.
 *
 * One screen, several steps, each reachable from the till's own menu by
 * `?action=`: open the till (`open`), an X report (`x`), the Z that closes
 * it (`z`), no sale (`no_sale`) and paid in or out (`paid_in_out`). A saved
 * report is `?report=<id>`, so a reload after an X shows that X again
 * rather than running another.
 *
 * Everything reads the till's state from `useTillCurrent()`, the query the
 * till itself shows "Open since 09:02" from, so opening or closing here
 * moves the till's header too. The cash the drawer should hold is never on
 * this screen outside a report: the Z count is blind until it is saved.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { formatGBP, type TillReport } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import type { CashAction } from "@/features/cash/actions"
import { CloseTill } from "@/features/cash/CloseTill"
import { DrawerSheet, type DrawerDone, type DrawerTask } from "@/features/cash/DrawerSheets"
import { OpenTill } from "@/features/cash/OpenTill"
import { BLOCKED, DockedPrimary } from "@/features/cash/primary"
import { REPORT_KEY, REPORTS_KEY } from "@/features/cash/keys"
import { ReportHistory } from "@/features/cash/ReportHistory"
import { ReportView } from "@/features/cash/ReportView"
import { OverrideCancelled, withOverride } from "@/features/lock/override"
import { openDrawer } from "@/features/printing/receipt"
import { EPOS_DEFAULTS, useCounterConfig } from "@/lib/api/config"
import { refusalOrFallback } from "@/lib/api/refusal"
import { currentRegisterId, TILL_CURRENT_KEY, useTillCurrent } from "@/lib/api/till-session"
import { getTillReport, runXReport } from "@/lib/api/tillops"

function time(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function Title() {
  return (
    <>
      <PageTitle>Cash up</PageTitle>
      <Lede>Open the till, move cash in and out, and close the day with a Z.</Lede>
    </>
  )
}

export function CashScreen() {
  const search = useSearch({ from: "/counter/cash" })
  const navigate = useNavigate({ from: "/counter/cash" })
  const queryClient = useQueryClient()
  const current = useTillCurrent()
  const { data: config } = useCounterConfig()

  const [sheet, setSheet] = React.useState<DrawerTask | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const session = current.data?.session ?? null
  const register = current.data?.register.name || "The till"
  const epos = config?.epos ?? null

  const go = React.useCallback(
    (next: { action?: CashAction; report?: string }, replace = false) =>
      void navigate({ search: next, replace }),
    [navigate]
  )

  /** Everything that reads the till's state, here and on the till itself. */
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: TILL_CURRENT_KEY })
    void queryClient.invalidateQueries({ queryKey: REPORTS_KEY })
    // Home's open-session line still reads the older route.
    void queryClient.invalidateQueries({ queryKey: ["cash-current"] })
  }, [queryClient])

  // The till's menu opens a drawer task here: while the till is open the
  // address opens its sheet, and closing the sheet takes the step off the
  // address so it does not open again.
  const wanted = search.action === "no_sale" || search.action === "paid_in_out" ? search.action : null
  const task: DrawerTask | null = sheet ?? (session && wanted ? wanted : null)
  const closeSheet = () => {
    setSheet(null)
    if (wanted) go({}, true)
  }

  function showReport(report: TillReport) {
    queryClient.setQueryData([...REPORT_KEY, report.id], report)
    refresh()
    go({ report: report.id }, true)
  }

  async function drawerDone(done: DrawerDone) {
    closeSheet()
    refresh()
    if (done.printJob) {
      setNotice(`${done.said} The drawer is opening.`)
      return
    }
    // The server had no printer to open the drawer through; ask the counter's
    // own printing path, and say so in one line if that cannot either.
    const outcome = await openDrawer(currentRegisterId()).catch(() => ({
      ok: false as const,
      message: "The drawer did not open. Use the drawer key.",
    }))
    setNotice(outcome.ok ? `${done.said} The drawer is opening.` : `${done.said} ${outcome.message}`)
  }

  if (search.report) {
    return (
      <section className="pt-16 sm:pt-24">
        <Title />
        <ReportLoader id={search.report} onBack={() => go({})} />
      </section>
    )
  }

  if (current.isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <Title />
        <SkeletonText lines={3} className="mt-14 max-w-[420px]" />
      </section>
    )
  }

  if (current.error) {
    return (
      <section className="pt-16 sm:pt-24">
        <Title />
        <p role="alert" className="mt-14 max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
          {refusalOrFallback(current.error, "The till's state would not load. Check the connection and try again.")}
        </p>
        <Button variant="text" className="mt-6" onClick={() => void current.refetch()}>
          Try again
        </Button>
      </section>
    )
  }

  if (session && search.action === "z") {
    const running = current.data?.running
    return (
      <section className="pt-16 sm:pt-24">
        <Title />
        <CloseTill
          register={register}
          tideRequired={
            (epos?.z_requires_card_total ?? EPOS_DEFAULTS.z_requires_card_total) &&
            (running?.card.till_total ?? 0) !== 0
          }
          onClosed={showReport}
          onBack={() => go({})}
        />
      </section>
    )
  }

  if (session && search.action === "x") {
    return (
      <section className="pt-16 sm:pt-24">
        <Title />
        <RunX onDone={showReport} onBack={() => go({})} />
      </section>
    )
  }

  return (
    <section className="pt-16 sm:pt-24">
      <Title />

      {notice ? (
        <p data-testid="cash-notice" aria-live="polite" className="mt-10 max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
          {notice}
        </p>
      ) : null}

      {session ? (
        <section className="mt-14" aria-labelledby="till-state-heading">
          <SectionHeading id="till-state-heading">{register}</SectionHeading>
          <div
            data-testid="till-state"
            className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-4 border-b border-hairline-soft pb-6"
          >
            <span className="flex flex-col gap-1">
              <span className="text-[15px] text-foreground">Open since {time(session.opened_at)}</span>
              <span className="text-[13px] text-muted-foreground-2">
                Opened by {session.opened_by.name} on a{" "}
                <span className="tnum">{formatGBP(session.float)}</span> float
              </span>
            </span>
            {current.data?.running ? (
              <span className="flex flex-col items-end gap-1">
                <MicroLabel>Taken so far</MicroLabel>
                <span data-testid="till-taken" className="tnum text-[20px] leading-none font-medium text-foreground">
                  {formatGBP(current.data.running.sales.net)}
                </span>
                <span className="text-[13px] text-muted-foreground-2">
                  {current.data.running.sales.count}{" "}
                  {current.data.running.sales.count === 1 ? "sale" : "sales"}
                </span>
              </span>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-2">
            <Button variant="text" onClick={() => go({ action: "x" })}>
              X report
            </Button>
            <Button variant="text" onClick={() => setSheet("paid_in_out")}>
              Paid in or out
            </Button>
            <Button variant="text" onClick={() => setSheet("bank_drop")}>
              Bank drop
            </Button>
            <Button variant="text" onClick={() => setSheet("no_sale")}>
              No sale
            </Button>
          </div>

          <DockedPrimary className="mt-12 hidden min-[900px]:block">
            <Button className={BLOCKED} trailingArrow onClick={() => go({ action: "z" })}>
              Cash up
            </Button>
          </DockedPrimary>
        </section>
      ) : (
        <OpenTill
          register={register}
          defaultFloat={epos?.default_float ?? EPOS_DEFAULTS.default_float}
          onOpened={() => {
            setNotice(null)
            refresh()
            go({}, true)
          }}
        />
      )}

      <ReportHistory onOpen={(id) => go({ report: id })} />

      <DrawerSheet
        task={task}
        onOpenChange={(open) => {
          if (!open) closeSheet()
        }}
        onDone={(done) => void drawerDone(done)}
      />
    </section>
  )
}

/**
 * Runs the X once, on arrival, and hands it on to be shown. A reload lands
 * on the saved report instead (`?report=`), so it never runs twice.
 */
function RunX({ onDone, onBack }: { onDone: (report: TillReport) => void; onBack: () => void }) {
  const started = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    withOverride((headers) => runXReport(headers), { describe: () => "Run an X report" })
      .then(onDone)
      .catch((cause: unknown) => {
        if (cause instanceof OverrideCancelled) {
          onBack()
          return
        }
        setError(refusalOrFallback(cause, "The X report did not run. Try again."))
      })
  }, [attempt, onDone, onBack])

  return (
    <div className="mt-14">
      {error ? (
        <>
          <p role="alert" className="max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
            {error}
          </p>
          <div className="mt-6 flex flex-wrap gap-8">
            <Button
              variant="text"
              onClick={() => {
                started.current = false
                setError(null)
                setAttempt((value) => value + 1)
              }}
            >
              Try again
            </Button>
            <Button variant="text" onClick={onBack}>
              Back
            </Button>
          </div>
        </>
      ) : (
        <p aria-busy="true" className="text-[15px] text-muted-foreground-2">
          Running the X report.
        </p>
      )}
    </div>
  )
}

/** A saved report: from the history, or the one just run (already in the cache). */
function ReportLoader({ id, onBack }: { id: string; onBack: () => void }) {
  const report = useQuery({
    queryKey: [...REPORT_KEY, id],
    queryFn: () =>
      withOverride((headers) => getTillReport(id, headers), {
        describe: () => "See an X or Z report",
      }),
    staleTime: Infinity,
    retry: false,
  })

  if (report.isPending) return <SkeletonText lines={6} className="mt-12 max-w-[420px]" />
  if (report.error || !report.data) {
    return (
      <div className="mt-12">
        <p role="alert" className="max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
          {report.error instanceof OverrideCancelled
            ? "That report needs a manager's approval to open."
            : refusalOrFallback(report.error, "That report would not load. Try again.")}
        </p>
        <Button variant="text" className="mt-6" onClick={onBack}>
          Back
        </Button>
      </div>
    )
  }
  return <ReportView report={report.data} onBack={onBack} />
}
