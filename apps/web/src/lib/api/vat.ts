/**
 * VAT (docs/api-contract-launch.md, section 3): the VAT return for a
 * quarter, the purchase figures for its boxes 4 and 7, and the till
 * products' treatments for Settings, VAT.
 *
 * - `GET /api/vault/reports/vat?period=2026-Q4` (`reports_view`) answers
 *   `VatReturn` from @gg/shared, which also adds it up.
 * - `POST /api/vault/reports/vat/purchases` (`settings_manage`)
 *   `{ period, vat, net }` in pence keeps the hand-entered figures for the
 *   quarter and answers the return with them in.
 * - A till product's treatment is its `tax_scheme` and `vat_rate`, written
 *   straight to the collection (managers and admins write till products).
 */
import { treatmentFields, type VatReturn, type VatTreatment } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import {
  demoSaveTillProductVat,
  demoSaveVatPurchases,
  demoTillProductsVat,
  demoVatReturn,
} from "@/lib/api/demo/vat"

/** The quarter's return. With no period, the quarter today is in. */
export async function getVatReturn(period?: string): Promise<VatReturn> {
  if (isDemo()) return demoVatReturn(period)
  const body = await pb.send<VatReturn>("/api/vault/reports/vat", {
    method: "GET",
    query: period ? { period } : {},
  })
  noteNetworkSuccess()
  return body
}

/** Boxes 4 and 7 for a quarter, in pence. */
export async function saveVatPurchases(input: { period: string; vat: number; net: number }): Promise<VatReturn> {
  if (isDemo()) return demoSaveVatPurchases(input)
  return pb.send<VatReturn>("/api/vault/reports/vat/purchases", { method: "POST", body: input })
}

/** A till product as Settings, VAT lists it. */
export interface TillProductVat {
  id: string
  name: string
  active: boolean
  tax_scheme: string
  vat_rate: number
}

export async function listTillProductsVat(): Promise<TillProductVat[]> {
  if (isDemo()) return demoTillProductsVat()
  const rows = await pb.collection("till_products").getFullList<TillProductVat>({
    sort: "sort,name",
    fields: "id,name,active,tax_scheme,vat_rate",
  })
  noteNetworkSuccess()
  return rows.map((row) => ({ ...row, vat_rate: row.vat_rate ?? 0 }))
}

export async function saveTillProductVat(id: string, treatment: VatTreatment): Promise<void> {
  if (isDemo()) {
    demoSaveTillProductVat(id, treatment)
    return
  }
  await pb.collection("till_products").update(id, treatmentFields(treatment))
}
