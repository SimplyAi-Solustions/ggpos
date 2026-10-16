/**
 * VAT in demo mode (docs/api-contract-launch.md, section 3): the return
 * from the demo sales actually rung up on the demo till, through the shared
 * `buildVatReturn`, the purchase figures for boxes 4 and 7 kept per quarter
 * for the tab, and the till products' treatments.
 *
 * A demo refund is counted on the day it is read, the demo's own today: the
 * demo keeps how many units of a line went back, not when.
 */
import {
  breakdown,
  buildVatReturn,
  keptLine,
  quarterOf,
  shopDateOf,
  standardRateOf,
  treatmentFields,
  vatApplies,
  vatQuarter,
  vatScopeStart,
  type VatPurchases,
  type VatReturn,
  type VatReturnRow,
  type VatTreatment,
} from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { demoSettings } from "@/lib/api/demo/settings"
import { demoSales, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import { DEMO_TILL_PRODUCTS } from "@/lib/api/demo/till"
import type { TillProductVat } from "@/lib/api/vat"

const purchases = new Map<string, VatPurchases>()

function settingsNow() {
  const settings = demoSettings()
  return {
    registration: { registered: settings.vat_registered === true, from: settings.vat_registered_from },
    standardRate: standardRateOf(settings.vat_standard_rate),
    startMonth: settings.vat_period_start_month || 1,
  }
}

/** The return for a period, "2026-Q4", or the quarter today is in. */
export function demoVatReturn(period?: string): VatReturn {
  ensureSeeded()
  const settings = settingsNow()
  const quarter =
    (period ? vatQuarter(period, settings.startMonth) : null) ??
    quarterOf(shopDateOf(new Date()), settings.startMonth)
  const start = vatScopeStart(quarter, settings.registration)
  const today = shopDateOf(new Date())
  const options = { inScope: true, standardRate: settings.standardRate }
  const rows: VatReturnRow[] = []

  if (start !== null) {
    for (const sale of demoSales) {
      const at = new Date(sale.created ?? "")
      if (Number.isNaN(at.getTime())) continue
      const day = shopDateOf(at)
      const inQuarter = day >= start && day <= quarter.to
      if (!vatApplies(settings.registration, at)) continue
      const split = breakdown(
        sale.lines.map((line) => ({
          id: line.id,
          qty: Math.max(1, line.qty ?? 1),
          unitPrice: line.unit_price ?? 0,
          discount: line.discount ?? 0,
          refundedQty: line.refunded_qty ?? 0,
        })),
        sale.discount ?? 0
      )
      const refundRef = (sale as { refunds?: { ref: string }[] }).refunds?.at(-1)?.ref ?? `${sale.number}-R1`
      for (const line of sale.lines) {
        const entry = split.byId[line.id]
        if (!entry) continue
        const item = line.item ? itemStore().find((row) => row.id === line.item) : undefined
        const figures = {
          net: entry.net,
          qty: entry.qty,
          unitCost: item?.cost ?? 0,
          scheme: line.tax_scheme ?? "margin",
          rate: line.vat_rate ?? 0,
        }
        const base = {
          sale: sale.id,
          title: line.title || "Item",
          sku: line.sku ?? "",
          scheme: figures.scheme,
          rate: figures.rate,
        }
        if (inQuarter) {
          const sold = keptLine(figures, 0, options)
          rows.push({ ...base, kind: "sale", ref: sale.number, date: day, gross: sold.gross, vat: sold.vat, cost: sold.cost })
        }
        const back = line.refunded_qty ?? 0
        if (back > 0 && today >= start && today <= quarter.to) {
          const was = keptLine(figures, 0, options)
          const now = keptLine(figures, back, options)
          rows.push({
            ...base,
            kind: "refund",
            ref: refundRef,
            date: today,
            gross: now.gross - was.gross,
            vat: now.vat - was.vat,
            cost: now.cost - was.cost,
          })
        }
      }
    }
  }

  return buildVatReturn({
    quarter,
    registration: settings.registration,
    standardRate: settings.standardRate,
    rows,
    purchases: purchases.get(quarter.period) ?? { vat: 0, net: 0, updated: "", by: "" },
  })
}

export function demoSaveVatPurchases(input: { period: string; vat: number; net: number }): VatReturn {
  const quarter = vatQuarter(input.period, settingsNow().startMonth)
  if (!quarter) throw new Error("Pick a quarter, as 2026-Q4.")
  purchases.set(quarter.period, {
    vat: input.vat,
    net: input.net,
    updated: new Date().toISOString(),
    by: DEMO_STAFF.name,
  })
  return demoVatReturn(quarter.period)
}

export function demoTillProductsVat(): TillProductVat[] {
  return DEMO_TILL_PRODUCTS.map((product) => ({
    id: product.id,
    name: product.name,
    active: product.active,
    tax_scheme: product.tax_scheme,
    vat_rate: product.vat_rate,
  }))
}

export function demoSaveTillProductVat(id: string, treatment: VatTreatment): void {
  const product = DEMO_TILL_PRODUCTS.find((row) => row.id === id)
  if (!product) throw new Error("That till product is not on file any more. Reload the page.")
  const fields = treatmentFields(treatment)
  product.tax_scheme = fields.tax_scheme
  product.vat_rate = fields.vat_rate
}
