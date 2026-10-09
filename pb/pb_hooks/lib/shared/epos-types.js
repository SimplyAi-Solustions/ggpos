// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * The EPOS shapes the server produces and the counter renders
 * (docs/api-contract-epos.md). Types only: one source of truth for the
 * sale and refund receipt, the X and Z report and the tenders, so a receipt
 * printed from the Mac and one printed from the tablet read the same.
 *
 * Money is integer GBP pence throughout. Dates are ISO 8601 strings.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DENOMINATIONS = exports.TENDER_LABELS = exports.TILL_TENDERS = exports.TENDER_METHODS = void 0;
/**
 * How a sale was paid, one row per tender (`sale_tenders.method`).
 * `sumup_card` exists only on sales taken before SumUp was removed.
 */
exports.TENDER_METHODS = [
    "cash",
    "card_tide",
    "card_other",
    "store_credit",
    "points",
    "part_exchange",
    "gift_card",
    "sumup_card",
];
/** What the till offers today. `card_other`, `gift_card` and `sumup_card` are for records only. */
exports.TILL_TENDERS = ["cash", "card_tide", "store_credit", "points"];
exports.TENDER_LABELS = {
    cash: "Cash",
    card_tide: "Card",
    card_other: "Card (other)",
    store_credit: "Store credit",
    points: "Points",
    part_exchange: "Part-exchange",
    gift_card: "Gift card",
    sumup_card: "Card (SumUp)",
};
/** UK notes and coins, in pence, largest first. Keys of a denomination count. */
exports.DENOMINATIONS = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
