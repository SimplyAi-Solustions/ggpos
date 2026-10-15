/**
 * The demo shop's suppliers (docs/api-contract-reorder.md, section 2.2),
 * answered from memory for the tab like every other demo store.
 *
 * A leaf module, so the demo item page can name an item's supplier without
 * importing the report, and the report can read the list without importing
 * the item page back. Refusals are the hook's own sentences.
 */
import { ClientResponseError } from "pocketbase"

import type { Supplier, SupplierInput } from "@/lib/api/types"

/** The id Games Workshop has in the demo, for tests and the fixtures. */
export const DEMO_GW_ID = "supplier_gw"
/** A second supplier with nothing on the shelf yet. */
export const DEMO_ASMODEE_ID = "supplier_asmodee"

const SUPPLIERS: Supplier[] = [
  {
    id: DEMO_GW_ID,
    name: "Games Workshop",
    accountNumber: "GW-48213",
    repName: "Dan",
    repEmail: "dan@example.co.uk",
    repPhone: "07700 900321",
    notes: "Trade order cut-off is Thursday at noon for Saturday delivery.",
    active: true,
    sort: 10,
  },
  {
    id: DEMO_ASMODEE_ID,
    name: "Asmodee UK",
    accountNumber: "ASM-20577",
    repName: "Priya",
    repEmail: "priya@example.co.uk",
    repPhone: "",
    notes: "",
    active: true,
    sort: 20,
  },
]

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

/** Every demo supplier, by sort then name. Copies, so a screen cannot edit the store. */
export function demoSuppliers(activeOnly = false): Supplier[] {
  return SUPPLIERS.filter((row) => !activeOnly || row.active)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "en-GB"))
    .map((row) => ({ ...row }))
}

export function demoSupplierById(id: string | undefined): Supplier | null {
  if (!id) return null
  const found = SUPPLIERS.find((row) => row.id === id)
  return found ? { ...found } : null
}

/** The hook's create and update: a trimmed, unique name. */
export function demoSaveSupplier(input: SupplierInput): Supplier {
  const name = input.name.trim()
  if (!name) refuse(400, "Give the supplier a name.")
  const clash = SUPPLIERS.find(
    (row) => row.id !== input.id && row.name.trim().toLowerCase() === name.toLowerCase()
  )
  // The name as it was typed, trimmed, as the hook says it.
  if (clash) refuse(400, `There is already a supplier called ${name}.`)

  const fields = {
    name,
    accountNumber: input.accountNumber.trim(),
    repName: input.repName.trim(),
    repEmail: input.repEmail.trim(),
    repPhone: input.repPhone.trim(),
    notes: input.notes.trim(),
    active: input.active,
  }
  if (input.id) {
    const row = SUPPLIERS.find((entry) => entry.id === input.id)
    if (!row) refuse(404, "That supplier was not found.")
    Object.assign(row, fields)
    return { ...row }
  }
  const row: Supplier = {
    id: `supplier_${Math.random().toString(36).slice(2, 10)}`,
    ...fields,
    sort: Math.max(0, ...SUPPLIERS.map((entry) => entry.sort)) + 10,
  }
  SUPPLIERS.push(row)
  return { ...row }
}
