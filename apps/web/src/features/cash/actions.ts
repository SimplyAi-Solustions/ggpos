/**
 * The steps `/counter/cash?action=` can open on. The till's menu links to
 * them (docs/api-contract-epos.md, section 3; the till package's brief), so
 * the names are the contract between the two screens.
 */
export const CASH_ACTIONS = ["open", "x", "z", "no_sale", "paid_in_out"] as const
export type CashAction = (typeof CASH_ACTIONS)[number]
