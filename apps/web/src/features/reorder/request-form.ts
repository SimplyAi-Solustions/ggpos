/**
 * The Add a request sheet's own checks, in the stock request hook's words
 * (docs/api-contract-reorder.md, section 2.4), said under the field before
 * anything is sent.
 */
import type { SaleCustomer } from "@/lib/api/types"

export interface RequestDraft {
  title: string
  /** Empty while somebody is retyping it. */
  qty: number | ""
  customer: SaleCustomer | null
  contactName: string
  contactPhone: string
  notes: string
}

export interface RequestProblems {
  title?: string
  qty?: string
  /** Neither a Guild member nor a name to contact. */
  who?: string
}

export function requestProblems(draft: RequestDraft): RequestProblems {
  const problems: RequestProblems = {}
  if (!draft.title.trim()) problems.title = "Say what the customer is after."
  if (draft.qty === "" || !Number.isInteger(draft.qty) || draft.qty < 1) {
    problems.qty = "The quantity is a whole number, 1 or more."
  }
  if (!draft.customer && !draft.contactName.trim()) {
    problems.who = "Add the customer, or a name to contact, so they can be told when it comes in."
  }
  return problems
}
