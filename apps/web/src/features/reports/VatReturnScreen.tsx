/**
 * The VAT return (docs/api-contract-launch.md, section 3): the nine boxes
 * for a quarter, the purchase figures for boxes 4 and 7 entered by hand,
 * the sales by rate, the margin scheme working and every sale and refund
 * behind them, with an Excel download. GG Vault does not file the return;
 * the screen says what to do with it.
 *
 * Every figure is the route's (`GET /api/vault/reports/vat`), added up by
 * the shared `buildVatReturn`; nothing here does VAT arithmetic.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ClientResponseError } from "pocketbase"
import {
  displayCode,
  formatGBP,
  parseDecimalToMinor,
  quarterLabel,
  quarterOf,
  recentQuarters,
  treatmentLabel,
  type VatReturn,
  type VatReturnLine,
  type VatTreatment,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SkeletonText } from "@/components/ui/skeleton"
import { useCounterDock } from "@/app/counter-dock"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { useStaff } from "@/lib/auth"
import { useVaultConfig } from "@/lib/api/config"
import { refusalOrFallback } from "@/lib/api/refusal"
import { getVatReturn, saveVatPurchases } from "@/lib/api/vat"
import { useToday } from "@/lib/use-today"
import type { ReportRow } from "@/lib/api/types"
import { buildCsv, downloadCsv, poundsCell } from "@/features/reports/csv"
import { downloadXlsx, sheet, xlsxFilename, type ExcelBook } from "@/features/reports/excel"
import { excelColumns } from "@/features/reports/excel-report"
import { formatDay } from "@/features/reports/range"
import { ReportTable } from "@/features/reports/ReportTable"
import { countColumn, moneyColumn, str, textColumn, type ColumnSpec } from "@/features/reports/specs"

/** The same treatment every other screen gives a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

/** What each box is, in HMRC's order and in plain words. */
const BOXES: { box: keyof VatReturn["boxes"]; number: number; says: (vat: VatReturn) => string }[] = [
  { box: "box1", number: 1, says: () => "VAT due on sales" },
  { box: "box2", number: 2, says: () => "VAT due on goods from the EU into Northern Ireland" },
  { box: "box3", number: 3, says: () => "Total VAT due, boxes 1 and 2" },
  { box: "box4", number: 4, says: () => "VAT reclaimed on purchases" },
  {
    box: "box5",
    number: 5,
    says: (vat) => (vat.box5_reclaim ? "Net VAT to reclaim from HMRC" : "Net VAT to pay HMRC"),
  },
  { box: "box6", number: 6, says: () => "Total sales excluding VAT, whole pounds" },
  { box: "box7", number: 7, says: () => "Total purchases excluding VAT, whole pounds" },
  { box: "box8", number: 8, says: () => "Goods supplied to the EU from Northern Ireland, whole pounds" },
  { box: "box9", number: 9, says: () => "Goods acquired from the EU into Northern Ireland, whole pounds" },
]

const BOX_COLUMNS: ColumnSpec[] = [
  { ...countColumn("number", "Box", "detail"), numeric: false },
  textColumn("says", "What it is", "title"),
  moneyColumn("amount", "Amount", "figure"),
]

const RATE_COLUMNS: ColumnSpec[] = [
  textColumn("label", "Rate", "title"),
  moneyColumn("gross", "Sales with VAT"),
  moneyColumn("net", "Without VAT", "detail"),
  moneyColumn("vat", "VAT", "figure"),
  countColumn("count", "Lines"),
]

/** A treatment as the drill-down says it. */
function treatmentWords(row: ReportRow, standardRate: number): string {
  const treatment = str(row, "treatment") as VatTreatment
  if (treatment === "standard") {
    const rate = Number(row.rate)
    // Sold inside the registration but before VAT was switched on at the till.
    if (!(rate > 0)) return "Standard, no VAT charged"
    if (rate !== standardRate) return `Standard rate, ${rate}%`
  }
  return treatmentLabel(treatment, standardRate)
}

function rowColumns(standardRate: number): ColumnSpec[] {
  return [
    {
      key: "date",
      label: "Day",
      summary: "detail",
      text: (row) => formatDay(str(row, "date")),
      sortValue: (row) => str(row, "date"),
      excel: "date",
      excelValue: (row) => str(row, "date"),
    },
    {
      key: "ref",
      label: "Sale",
      text: (row) => str(row, "ref"),
      sortValue: (row) => str(row, "ref"),
      cell: (row) => <span className="tnum font-mono text-[13px]">{str(row, "ref")}</span>,
    },
    textColumn("title", "Item", "title"),
    {
      key: "sku",
      label: "SKU",
      text: (row) => (str(row, "sku") ? displayCode(str(row, "sku")) : ""),
      sortValue: (row) => str(row, "sku"),
    },
    {
      key: "treatment",
      label: "Treatment",
      text: (row) => treatmentWords(row, standardRate),
      sortValue: (row) => str(row, "group"),
    },
    moneyColumn("gross", "With VAT"),
    moneyColumn("cost", "Cost"),
    moneyColumn("vat", "VAT", "figure"),
  ]
}

function asRows<T extends object>(rows: readonly T[]): ReportRow[] {
  return rows.map((row) => ({ ...row }) as unknown as ReportRow)
}

function boxRows(vat: VatReturn): ReportRow[] {
  return BOXES.map((entry) => ({ number: entry.number, says: entry.says(vat), amount: vat.boxes[entry.box] }) as ReportRow)
}

/** "1/6" at 20 percent, "1/21" at 5, and the plain fraction otherwise. */
function fractionOf(rate: number): string {
  if (rate === 20) return "1/6"
  if (rate === 5) return "1/21"
  return `${rate}/${100 + rate}`
}

const MTD_NOTE =
  "GG Vault does not file the return. Copy boxes 1 to 9 into the Making Tax Digital software the shop uses (bridging software, or your accountant's) and submit it there by the deadline, then keep this Excel file with the VAT records."

function returnBook(vat: VatReturn, rows: ReportRow[], standardRate: number): ExcelBook {
  const margin = vat.margin
  return {
    title: "VAT return",
    period: `${quarterLabel(vat)} (${vat.period})`,
    made: new Date(),
    sheets: [
      sheet("Boxes", excelColumns(BOX_COLUMNS), boxRows(vat)),
      sheet("By rate", excelColumns(RATE_COLUMNS), asRows(vat.by_rate)),
      sheet(
        "Margin scheme",
        [
          { label: "Figure", kind: "text", value: (row: { label: string; value: number }) => row.label },
          { label: "Amount", kind: "money", value: (row: { label: string; value: number }) => row.value },
        ],
        [
          { label: "Sales of margin scheme goods", value: margin.sales },
          { label: "What they cost", value: margin.cost },
          { label: "Margin", value: margin.margin },
          { label: `VAT at ${fractionOf(standardRate)} of each margin`, value: margin.vat },
        ]
      ),
      sheet("Sales behind it", excelColumns(rowColumns(standardRate)), rows),
    ],
    notes: [vat.note, MTD_NOTE].filter(Boolean),
  }
}

/** Boxes 4 and 7, entered by an admin for the quarter until purchases are recorded. */
function Purchases({ vat, admin }: { vat: VatReturn; admin: boolean }) {
  const queryClient = useQueryClient()
  const [box4, setBox4] = React.useState(() => penceToField(vat.purchases.vat))
  const [box7, setBox7] = React.useState(() => penceToField(vat.purchases.net))
  const [problem, setProblem] = React.useState<string | null>(null)
  const save = useMutation({
    mutationFn: (input: { vat: number; net: number }) => saveVatPurchases({ period: vat.period, ...input }),
    onSuccess: (fresh) => {
      setProblem(null)
      queryClient.setQueryData(["vat-return", vat.period], fresh)
    },
    onError: (err) => setProblem(refusalOrFallback(err, "Those figures did not save. Try again.")),
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const vatPence = parseDecimalToMinor(box4)
    const netPence = parseDecimalToMinor(box7)
    if (vatPence === null || netPence === null || vatPence < 0 || netPence < 0) {
      setProblem("Enter both amounts in pounds and pence, for example 123.45.")
      return
    }
    save.mutate({ vat: vatPence, net: netPence })
  }

  if (!admin) {
    return (
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        Purchases come to {formatGBP(vat.purchases.vat)} of VAT on {formatGBP(vat.purchases.net)}. An admin enters them.
      </p>
    )
  }

  return (
    <form onSubmit={submit} aria-label="Purchases for boxes 4 and 7" className="flex flex-col gap-10">
      <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        From the purchase invoices for the quarter, until GG Vault records purchases. Buy-ins from the public carry no
        VAT, but what was paid for them belongs in box 7.
      </p>
      <Field label="Box 4, VAT on purchases" htmlFor="vat-box4">
        <MoneyInput id="vat-box4" value={box4} onChange={setBox4} invalid={Boolean(problem)} />
      </Field>
      <Field label="Box 7, net purchases" htmlFor="vat-box7">
        <MoneyInput id="vat-box7" value={box7} onChange={setBox7} invalid={Boolean(problem)} />
      </Field>
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="text" type="submit" loading={save.isPending}>
          Save purchases
        </Button>
        {vat.purchases.updated ? (
          <span className="text-[13px] text-muted-foreground-2">
            Entered by {vat.purchases.by || "an admin"} on {formatDay(vat.purchases.updated.slice(0, 10))}.
          </span>
        ) : null}
      </div>
      <FieldError>{problem}</FieldError>
    </form>
  )
}

export function VatReturnScreen() {
  const dock = useCounterDock()
  const today = useToday()
  const admin = useStaff()?.role === "admin"
  const { data: config } = useVaultConfig()
  const startMonth = config?.settings.vat_period_start_month || 1
  const quarters = React.useMemo(() => recentQuarters(today, startMonth, 8), [today, startMonth])
  const [period, setPeriod] = React.useState(() => quarterOf(today, startMonth).period)
  const [group, setGroup] = React.useState("all")

  const query = useQuery({
    queryKey: ["vat-return", period],
    queryFn: () => getVatReturn(period),
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ClientResponseError && error.status === 403) && count < 2,
  })
  const vat = query.data ?? null
  const refused = query.error instanceof ClientResponseError && query.error.status === 403
  const standardRate = vat?.standard_rate ?? 20

  const lines: VatReturnLine[] = React.useMemo(() => vat?.rows ?? [], [vat])
  const shown = React.useMemo(
    () => asRows(group === "all" ? lines : lines.filter((line) => line.group === group)),
    [lines, group]
  )
  const columns = React.useMemo(() => rowColumns(standardRate), [standardRate])

  function exportExcel() {
    if (!vat) return
    downloadXlsx(xlsxFilename(`vat-return-${vat.period}`), returnBook(vat, asRows(lines), standardRate))
  }

  function exportCsv() {
    if (!vat) return
    const text = buildCsv(
      [
        { label: "Box", value: (row: ReportRow) => String(row.number) },
        { label: "What it is", value: (row: ReportRow) => str(row, "says") },
        { label: "Amount", value: (row: ReportRow) => poundsCell(Number(row.amount)) },
      ],
      boxRows(vat)
    )
    downloadCsv(`gg-vault-vat-return-${vat.period}.csv`, text)
  }

  const primary = (
    <Button className={`w-full min-[900px]:w-auto ${BLOCKED}`} trailingArrow disabled={!vat} onClick={exportExcel}>
      Export Excel
    </Button>
  )

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>VAT return</PageTitle>
      <Lede>The nine boxes for a quarter, from what the till took. Copy them into your MTD software to file.</Lede>

      <div className="mt-10 max-w-[28rem]">
        <Field label="Quarter" htmlFor="vat-period" layout="stacked">
          <Select value={period} onValueChange={(next) => next && setPeriod(String(next))}>
            <SelectTrigger id="vat-period" data-testid="vat-period">
              <SelectValue>
                {(value: string) => {
                  const quarter = quarters.find((entry) => entry.period === value)
                  return quarter ? `${quarterLabel(quarter)} (${quarter.period})` : value
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {quarters.map((quarter) => (
                <SelectItem key={quarter.period} value={quarter.period}>
                  {quarterLabel(quarter)} ({quarter.period})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {refused ? (
        <p className="mt-12 max-w-[56ch] text-[15px] text-muted-foreground">
          The VAT return is for managers and admins. Ask one to take it.
        </p>
      ) : query.error ? (
        <p role="alert" className="mt-12 text-[15px] text-destructive">
          {refusalOrFallback(query.error, "The VAT return would not load. Check the connection and try again.")}
        </p>
      ) : !vat ? (
        <SkeletonText lines={5} className="mt-12 max-w-[40rem]" />
      ) : (
        <>
          {vat.note ? (
            <p data-testid="vat-note" className="mt-10 max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
              {vat.note}
            </p>
          ) : null}

          <section className="mt-16">
            <SectionHeading>The nine boxes</SectionHeading>
            <ReportTable testId="vat-boxes" columns={BOX_COLUMNS} rows={boxRows(vat)} empty="" />
            <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">{MTD_NOTE}</p>
          </section>

          {vat.registered ? (
            <>
              <section className="mt-16">
                <SectionHeading>Purchases</SectionHeading>
                <Purchases key={vat.period} vat={vat} admin={admin} />
              </section>

              <section className="mt-16">
                <SectionHeading>By rate</SectionHeading>
                <ReportTable
                  testId="vat-by-rate"
                  columns={RATE_COLUMNS}
                  rows={asRows(vat.by_rate)}
                  empty="Nothing was sold in this quarter."
                />
              </section>

              <section className="mt-16">
                <SectionHeading>Margin scheme</SectionHeading>
                <dl data-testid="vat-margin" className="grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-4">
                  {[
                    { label: "Sales", value: vat.margin.sales },
                    { label: "What they cost", value: vat.margin.cost },
                    { label: "Margin", value: vat.margin.margin },
                    { label: `VAT at ${fractionOf(standardRate)}`, value: vat.margin.vat },
                  ].map((figure) => (
                    <div key={figure.label} className="flex flex-col gap-2">
                      <dt>
                        <MicroLabel>{figure.label}</MicroLabel>
                      </dt>
                      <dd className="m-0">
                        <span className="tnum text-[20px] leading-none font-medium text-foreground">
                          {formatGBP(figure.value)}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                  Second-hand goods bought from the public, from the stock book: what each sold for less what it
                  cost, and the VAT on that margin line by line. A sale at a loss carries none, and does not take
                  any off another.
                </p>
              </section>

              <section className="mt-16">
                <SectionHeading>Sales behind it</SectionHeading>
                {vat.by_rate.length > 1 ? (
                  <ChipGroup
                    aria-label="Show the lines for"
                    className="mb-6"
                    value={[group]}
                    onValueChange={(next: string[]) => setGroup(next[0] ?? "all")}
                  >
                    <Chip value="all">All</Chip>
                    {vat.by_rate.map((rate) => (
                      <Chip key={rate.key} value={rate.key}>
                        {rate.label}
                      </Chip>
                    ))}
                  </ChipGroup>
                ) : null}
                <ReportTable
                  testId="vat-rows"
                  columns={columns}
                  rows={shown}
                  empty="No sales or refunds in this quarter."
                  limit={200}
                />
                <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                  Each line as it was sold, and each refund in the quarter it was given, so a return once sent never
                  changes. The Excel file carries every line.
                </p>
              </section>
            </>
          ) : null}
        </>
      )}

      <div className="mt-24 flex flex-wrap items-center gap-8">
        <div className="hidden min-[900px]:block">{primary}</div>
        <Button variant="text" disabled={!vat} onClick={exportCsv}>
          Export CSV
        </Button>
        <Button variant="text" render={<Link to="/counter/reports" />}>
          All reports
        </Button>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">{primary}</div>,
            dock
          )
        : null}
    </section>
  )
}
