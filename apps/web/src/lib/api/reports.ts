/**
 * Reports: the nine report reads, the `daily_stats` rows Home draws its
 * sparklines from, and the saved views behind them.
 *
 * `GET /api/vault/reports/:key` answers one envelope for every key
 * (docs/api-contract.md, "Phase 4: stats and reports"), so there is one call
 * here rather than nine. The screens read the envelope through the per-report
 * specs in `features/reports/`, which is the one place a key's own column
 * names are written down.
 *
 * Nothing here imports Recharts or the chart component: the chart code lives
 * on the report routes alone, so the entry chunk never carries it.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { addDays, todayIso } from "@/lib/api/dates"
import {
  demoDailyStats,
  demoDeleteReport,
  demoReport,
  demoSaveReport,
  demoSavedReports,
  demoSparklines,
} from "@/lib/api/demo/reports"
import type {
  DailyStatRow,
  ReportEnvelope,
  ReportKey,
  ReportQuery,
  SavedReportInput,
  SavedReportRecord,
  SparklineSeries,
} from "@/lib/api/types"

/**
 * PocketBase stores a date as `YYYY-MM-DD HH:MM:SS.sssZ`, never a bare day,
 * and the last second of a day has a thousand milliseconds in it: an upper
 * bound of `23:59:59` silently drops a row written at `23:59:59.500`.
 */
function dayStart(iso: string): string {
  return `${iso} 00:00:00.000Z`
}

function dayEnd(iso: string): string {
  return `${iso} 23:59:59.999Z`
}

function queryOf(query: ReportQuery): Record<string, string> {
  const params: Record<string, string> = { from: query.from, to: query.to }
  if (query.group) params.group = query.group
  if (query.by) params.by = query.by
  if (query.compare) params.compare = query.compare
  return params
}

/** One report over one range. The route refuses a bad range with a message. */
export async function getReport(
  key: ReportKey,
  query: ReportQuery
): Promise<ReportEnvelope> {
  if (isDemo()) return demoReport(key, query)
  const envelope = await pb.send<ReportEnvelope>(`/api/vault/reports/${key}`, {
    method: "GET",
    query: queryOf(query),
  })
  noteNetworkSuccess()
  return envelope
}

/**
 * The `daily_stats` rows in a range, oldest first.
 *
 * The collection is staff-readable, so this is a plain read rather than a
 * route: `stats/rebuild` is the only custom route on it and that is an admin
 * write. A day the nightly cron has not reached yet is simply missing, which
 * is what the caller has to allow for.
 */
export async function getDailyStats(
  from: string,
  to: string
): Promise<DailyStatRow[]> {
  if (isDemo()) return demoDailyStats(from, to)
  const rows = await pb.collection("daily_stats").getFullList<DailyStatRow>({
    // Parameterised rather than interpolated: the SDK escapes the values,
    // so a date that is not a date cannot become filter syntax.
    filter: pb.filter("date >= {:from} && date <= {:to}", {
      from: dayStart(from),
      to: dayEnd(to),
    }),
    sort: "date",
  })
  noteNetworkSuccess()
  return rows.map((row) => ({ ...row, date: String(row.date).slice(0, 10) }))
}

/**
 * The four Home tiles over the last `days` UTC days.
 *
 * Three of the four are on `daily_stats` itself. Cash out is not: money
 * leaving the drawer is a `cash_movements` figure, and the cash report is
 * where it is already summed per day, so that one comes from there. A day
 * with no row reads as zero rather than breaking the line.
 */
export async function getSparklines(days = 30): Promise<SparklineSeries> {
  const to = todayIso()
  const from = addDays(to, -(days - 1))
  if (isDemo()) return demoSparklines(days)

  const [stats, cash] = await Promise.all([
    getDailyStats(from, to),
    getReport("cash", { from, to, group: "day" }).catch(() => null),
  ])

  const byDate = new Map(stats.map((row) => [row.date, row]))
  const cashByDate = new Map<string, number>()
  const byDay = (cash?.totals?.by_day ?? []) as { date?: string; out?: number }[]
  for (const row of byDay) {
    if (row?.date) cashByDate.set(String(row.date).slice(0, 10), row.out ?? 0)
  }

  const dates: string[] = []
  for (let offset = 0; offset < days; offset += 1) dates.push(addDays(from, offset))

  return {
    dates,
    // Net of refunds: the payment split is gross, so the day's own
    // `sales_refunded` comes off it, exactly as the sales report does.
    sales: dates.map((date) => {
      const row = byDate.get(date)
      const gross = Object.values(row?.sales_total_by_payment ?? {}).reduce(
        (carry, amount) => carry + amount,
        0
      )
      return gross - (row?.sales_refunded ?? 0)
    }),
    buyIns: dates.map((date) => {
      const payout = byDate.get(date)?.buy_in_total_by_payout ?? {}
      return (payout.cash ?? 0) + (payout.credit ?? 0)
    }),
    cashOut: dates.map((date) => cashByDate.get(date) ?? 0),
    creditIssued: dates.map((date) => byDate.get(date)?.credit_issued ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Saved views
//
// `saved_reports` is an ordinary staff collection (docs/api-contract.md,
// "Saved and scheduled reports"). `filters` holds `{ by, group }` only: the
// period a scheduled send covers is always computed fresh from the schedule,
// so a saved weekly report covers the week that just ended rather than a
// stale literal date.
// ---------------------------------------------------------------------------

export async function listSavedReports(key?: ReportKey): Promise<SavedReportRecord[]> {
  if (isDemo()) return demoSavedReports(key)
  const rows = await pb.collection("saved_reports").getFullList<SavedReportRecord>({
    filter: key ? `report_key = "${key}"` : "",
    sort: "name",
  })
  noteNetworkSuccess()
  return rows
}

/**
 * Save a view. Only an admin may schedule one: an ordinary staff member's
 * save carries the name and the filters and nothing else, so a schedule or a
 * recipient list cannot reach the record from a screen that never offered
 * them, however the call was made.
 */
export async function saveSavedReport(
  input: SavedReportInput,
  options: { admin: boolean }
): Promise<SavedReportRecord> {
  if (isDemo()) return demoSaveReport(input, options)
  const body = {
    owner: pb.authStore.record?.id,
    report_key: input.report_key,
    name: input.name,
    filters: input.filters,
    ...(options.admin
      ? { schedule: input.schedule, recipients: input.recipients }
      : {}),
  }
  if (input.id) {
    return pb.collection("saved_reports").update<SavedReportRecord>(input.id, body)
  }
  return pb.collection("saved_reports").create<SavedReportRecord>(body)
}

export async function deleteSavedReport(id: string): Promise<void> {
  if (isDemo()) {
    demoDeleteReport(id)
    return
  }
  await pb.collection("saved_reports").delete(id)
}
