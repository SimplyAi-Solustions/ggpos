// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DASHBOARD_TOP_ITEMS = void 0;
exports.daysFromTo = daysFromTo;
exports.profitPct = profitPct;
exports.dashboardHeadline = dashboardHeadline;
exports.summariseDashboard = summariseDashboard;
/**
 * The reports dashboard (docs/api-contract-launch.md, section 3,
 * `GET /api/vault/reports/dashboard`): sales, cost and profit over a range,
 * added up from one entry per sale line.
 *
 * Pure and shared: the route gathers the lines (through the margin report's
 * own line walk, so the two agree to the penny) and the demo builds its own,
 * and both add them up here.
 *
 * - **gross** is what the lines came to before any discount, **discounts**
 *   the line and ticket discounts, **refunds** what has gone back on the
 *   range's sales whenever it was given, and **net** what is left: the
 *   margin report's revenue.
 * - **vat** is the VAT due on what was kept: standard and reduced lines at
 *   the rate they were charged, and the margin scheme's VAT on each margin
 *   line inside the registration.
 * - **cost** is what the stock kept cost (`items.cost` times the quantity
 *   kept); a till product has none.
 * - **profit** is net less VAT less cost, and **margin_pct** is profit as a
 *   percentage of net less VAT: of what the shop actually earned on its
 *   sales once the VAT is paid over.
 */
const money_1 = require("./money");
/** How many items the top items list carries. */
exports.DASHBOARD_TOP_ITEMS = 10;
/** Every day from `from` to `to`, both included, YYYY-MM-DD. */
function daysFromTo(from, to) {
    const out = [];
    const at = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(at.getTime()) || Number.isNaN(end.getTime()))
        return out;
    while (at.getTime() <= end.getTime() && out.length < 1000) {
        out.push(at.toISOString().slice(0, 10));
        at.setUTCDate(at.getUTCDate() + 1);
    }
    return out;
}
/**
 * Profit as a percentage of a base, to one place, half-up: 0 when the base
 * is nothing. The figure itself is a ratio, not money, so the one division
 * here never reaches a penny.
 */
function profitPct(profit, base) {
    if (!(base > 0))
        return 0;
    return (0, money_1.roundHalfUp)((profit * 1000) / base) / 10;
}
/** Net, VAT and cost into profit and its margin. */
function earned(net, vat, cost) {
    const profit = net - vat - cost;
    return { profit, margin_pct: profitPct(profit, net - vat) };
}
/** The headline figures alone, for the comparison period. */
function dashboardHeadline(input) {
    let gross = 0;
    let discounts = 0;
    let refunds = 0;
    let vat = 0;
    let cost = 0;
    for (const line of input.lines) {
        gross += line.gross;
        discounts += line.discount;
        refunds += line.refunded;
        vat += line.vat;
        cost += line.cost;
    }
    const net = gross - discounts - refunds;
    const count = Math.max(0, input.saleCount);
    return Object.assign(Object.assign({ sales: {
            gross,
            discounts,
            refunds,
            net,
            vat,
            count,
            average: count > 0 ? (0, money_1.roundHalfUp)(net / count) : 0,
        }, cost }, earned(net, vat, cost)), { buy_ins: { spend: input.buyIns.spend, count: input.buyIns.count } });
}
/** The whole dashboard for one range (the route adds `compare`). */
function summariseDashboard(input) {
    var _a, _b, _c;
    const headline = dashboardHeadline(input);
    const days = new Map();
    for (const day of daysFromTo(input.from, input.to))
        days.set(day, { net: 0, vat: 0, cost: 0 });
    const branches = new Map();
    const items = new Map();
    for (const line of input.lines) {
        const net = line.gross - line.discount - line.refunded;
        const day = days.get(line.date);
        if (day) {
            day.net += net;
            day.vat += line.vat;
            day.cost += line.cost;
        }
        const branch = (_a = branches.get(line.branch.id)) !== null && _a !== void 0 ? _a : { id: line.branch.id, label: line.branch.label, net: 0, vat: 0, cost: 0 };
        branch.net += net;
        branch.vat += line.vat;
        branch.cost += line.cost;
        branches.set(line.branch.id, branch);
        // A line refunded in full sold nothing, so it is no top item.
        if (line.qty > 0) {
            const item = (_b = items.get(line.key)) !== null && _b !== void 0 ? _b : { title: line.title, sku: line.sku, net: 0, vat: 0, cost: 0, count: 0 };
            item.net += net;
            item.vat += line.vat;
            item.cost += line.cost;
            item.count += line.qty;
            items.set(line.key, item);
        }
    }
    const byNet = (label) => (a, b) => b.net - a.net || (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0);
    const payments = new Map();
    for (const payment of input.payments) {
        const row = (_c = payments.get(payment.method)) !== null && _c !== void 0 ? _c : { method: payment.method, label: payment.label, net: 0 };
        row.net += payment.amount;
        payments.set(payment.method, row);
    }
    return Object.assign(Object.assign({ from: input.from, to: input.to }, headline), { stock: Object.assign({}, input.stock), series: [...days.entries()].map(([date, day]) => ({
            date,
            net: day.net,
            cost: day.cost,
            profit: day.net - day.vat - day.cost,
        })), by_category: [...branches.values()]
            .map((row) => (Object.assign({ id: row.id, label: row.label, net: row.net, cost: row.cost }, earned(row.net, row.vat, row.cost))))
            .sort(byNet((row) => row.label)), top_items: [...items.values()]
            .map((row) => ({ title: row.title, sku: row.sku, net: row.net, profit: row.net - row.vat - row.cost, count: row.count }))
            .sort(byNet((row) => row.title))
            .slice(0, exports.DASHBOARD_TOP_ITEMS), payments: [...payments.values()].filter((row) => row.net !== 0).sort(byNet((row) => row.label)) });
}
