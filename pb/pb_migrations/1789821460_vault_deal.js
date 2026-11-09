/// <reference path="../pb_data/types.d.ts" />

/**
 * What the Vault deal calculator stores on a buy-in, in the shape of the
 * canonical deal maths (packages/shared/src/deal.ts: computeDeal(inputs,
 * rates, overrides), where overrides is { trade?, cash? } and each side is
 * { kind: "amount", pence } or { kind: "pct", pct }). Additive only: every
 * new field is optional, so the counter's buy-in wizard and its completion
 * route carry on unchanged.
 *
 * Added to `trade_ins`:
 *  - trade_pct, cash_pct   the deal's sweep rates (DealRates). 0 or empty
 *                          means DEFAULT_DEAL_RATES, 80 and 70. 0 to 200,
 *                          the range clampDealPct allows.
 *  - trade_override_kind   `amount` or `pct`; empty means the trade side is
 *                          not overridden. Then trade_override_pence (the
 *                          new trade total) or trade_override_pct (a new
 *                          percentage of market).
 *  - cash_override_kind, cash_override_pence, cash_override_pct  the same
 *                          for the cash side. The two sides are independent.
 *  - override_reason       why, free text (stays on the row, never audited).
 *  - override_by, override_at  who last changed either override and when.
 *                          Stamped by the server (vaultdeal.pb.js) from the
 *                          caller's token, never taken from the request body.
 *  - calculated_trade, calculated_cash  pence: the totals the rates made
 *                          before any override, written at completion.
 *  - deal_trade_total, deal_cash_total  pence: the deal's final totals,
 *                          written at completion by
 *                          POST /api/vault/deals/{id}/complete.
 *  The split reuses `payout_cash` (cash taken) and `payout_credit` (credit
 *  given), already on the row.
 *
 * Added to `trade_in_lines`:
 *  - trade_pct, cash_pct   per-card rates. JSON so they can be null: null
 *                          (or absent) follows the deal's sweep; a number 0
 *                          to 200 is the card's own rate.
 *  The line's market value and its source reuse `market_price` (pence per
 *  unit, condition-adjusted) and `market_source`. A line priced by hand
 *  reuses `override_reason` with `override_credit` / `override_cash`, which
 *  become the canonical fixedTrade / fixedCash.
 */
migrate(
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    const tradeIns = app.findCollectionByNameOrId("trade_ins");

    const pct = (name) => new Field({ name: name, type: "number", min: 0, max: 200 });
    const pence = (name) => new Field({ name: name, type: "number", onlyInt: true, min: 0 });
    const kind = (name) => new Field({ name: name, type: "select", maxSelect: 1, values: ["amount", "pct"] });

    tradeIns.fields.add(pct("trade_pct"));
    tradeIns.fields.add(pct("cash_pct"));
    tradeIns.fields.add(kind("trade_override_kind"));
    tradeIns.fields.add(pence("trade_override_pence"));
    tradeIns.fields.add(pct("trade_override_pct"));
    tradeIns.fields.add(kind("cash_override_kind"));
    tradeIns.fields.add(pence("cash_override_pence"));
    tradeIns.fields.add(pct("cash_override_pct"));
    tradeIns.fields.add(new Field({ name: "override_reason", type: "text", max: 500 }));
    tradeIns.fields.add(
      new Field({ name: "override_by", type: "relation", collectionId: staff.id, maxSelect: 1 })
    );
    tradeIns.fields.add(new Field({ name: "override_at", type: "date" }));
    tradeIns.fields.add(pence("calculated_trade"));
    tradeIns.fields.add(pence("calculated_cash"));
    tradeIns.fields.add(pence("deal_trade_total"));
    tradeIns.fields.add(pence("deal_cash_total"));
    app.save(tradeIns);

    const lines = app.findCollectionByNameOrId("trade_in_lines");
    lines.fields.add(new Field({ name: "trade_pct", type: "json", maxSize: 64 }));
    lines.fields.add(new Field({ name: "cash_pct", type: "json", maxSize: 64 }));
    app.save(lines);
  },
  (app) => {
    const lines = app.findCollectionByNameOrId("trade_in_lines");
    lines.fields.removeByName("cash_pct");
    lines.fields.removeByName("trade_pct");
    app.save(lines);

    const tradeIns = app.findCollectionByNameOrId("trade_ins");
    [
      "deal_cash_total",
      "deal_trade_total",
      "calculated_cash",
      "calculated_trade",
      "override_at",
      "override_by",
      "override_reason",
      "cash_override_pct",
      "cash_override_pence",
      "cash_override_kind",
      "trade_override_pct",
      "trade_override_pence",
      "trade_override_kind",
      "cash_pct",
      "trade_pct",
    ].forEach((name) => tradeIns.fields.removeByName(name));
    app.save(tradeIns);
  }
);
