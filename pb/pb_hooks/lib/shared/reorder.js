// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * The supplier reorder report (docs/api-contract-reorder.md): for the weekly
 * call with a supplier's rep, what of theirs is in stock, what sold, what is
 * out, what to order to fill the shelf back up, and what customers have asked
 * for.
 *
 * Pure and shared: the route (`GET /api/vault/reorder`) reads the supplier's
 * stock rows, the units sold in the range and the open requests, and the
 * demo builds its own; both add them up here so the two always agree.
 *
 * - A **product** is every stock row of the supplier's that is the same
 *   thing: the same supplier code, else the same barcode, else the same
 *   title. Restocking adds a new row (there is no goods-in yet), so a product
 *   that sold out last month and came back this week is two rows and one
 *   line here.
 * - **In stock** is the units on hand across those rows: a row's `qty` while
 *   it is in stock, reserved or listed, nothing once it is sold, returned or
 *   written off.
 * - **Shelf target** is how many to keep on the shelf; 0 means the product
 *   is not kept to a target. Rows of one product that disagree take the
 *   largest.
 * - **To order** tops the shelf back up: target less in stock, never below
 *   0, and 0 for a product with no target.
 * - **Sold** is units kept (sold less refunded) in the range.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPEN_REQUEST_STATUSES = exports.REQUEST_STATUS_LABELS = exports.REQUEST_STATUSES = exports.REORDER_STATUS_LABELS = void 0;
exports.isOpenRequest = isOpenRequest;
exports.productKey = productKey;
exports.reorderStatus = reorderStatus;
exports.unitsToOrder = unitsToOrder;
exports.buildReorderLines = buildReorderLines;
exports.reorderTotals = reorderTotals;
exports.defaultReorderPeriod = defaultReorderPeriod;
exports.REORDER_STATUS_LABELS = {
    out: "Out of stock",
    low: "Below target",
    ok: "Stocked",
    untracked: "No target",
};
/** A customer's request for something the shop does not have. */
exports.REQUEST_STATUSES = ["waiting", "asked", "ordered", "arrived", "collected", "cancelled"];
exports.REQUEST_STATUS_LABELS = {
    waiting: "Waiting",
    asked: "Asked the rep",
    ordered: "Ordered",
    arrived: "Arrived",
    collected: "Collected",
    cancelled: "Cancelled",
};
/** Still needs something doing: everything before Collected, and not Cancelled. */
exports.OPEN_REQUEST_STATUSES = ["waiting", "asked", "ordered", "arrived"];
function isOpenRequest(status) {
    return exports.OPEN_REQUEST_STATUSES.includes(status);
}
const STATUS_RANK = { out: 0, low: 1, ok: 2, untracked: 3 };
/** The same product across restocks: supplier code, else barcode, else title. */
function productKey(item) {
    const code = item.supplierCode.trim().toLowerCase();
    if (code)
        return `code:${code}`;
    const ean = item.ean.trim();
    if (ean)
        return `ean:${ean}`;
    return `title:${item.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}
/** A product's status from what is on hand and its target. */
function reorderStatus(inStock, shelfTarget) {
    if (inStock <= 0)
        return "out";
    if (shelfTarget <= 0)
        return "untracked";
    return inStock < shelfTarget ? "low" : "ok";
}
/** How many to order to bring the shelf back to its target. */
function unitsToOrder(inStock, shelfTarget) {
    return shelfTarget > 0 ? Math.max(0, shelfTarget - Math.max(0, inStock)) : 0;
}
const whole = (n) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
/**
 * The report's lines, one per product: what to order first (most units),
 * then out of stock, below target, stocked and untargeted, then by title.
 */
function buildReorderLines(items, sold) {
    var _a, _b, _c, _d, _e, _f;
    const soldBy = new Map();
    for (const s of sold)
        soldBy.set(s.itemId, ((_a = soldBy.get(s.itemId)) !== null && _a !== void 0 ? _a : 0) + whole(s.qty));
    const groups = new Map();
    for (const item of items) {
        const key = productKey(item);
        const rows = groups.get(key);
        if (rows)
            rows.push(item);
        else
            groups.set(key, [item]);
    }
    const lines = [];
    for (const [key, rows] of groups) {
        const newestFirst = [...rows].sort((a, b) => b.updated.localeCompare(a.updated));
        const named = newestFirst[0];
        if (!named)
            continue;
        const open = (_b = newestFirst.find((row) => whole(row.onHand) > 0)) !== null && _b !== void 0 ? _b : named;
        const inStock = rows.reduce((sum, row) => sum + whole(row.onHand), 0);
        const shelfTarget = rows.reduce((max, row) => Math.max(max, whole(row.shelfTarget)), 0);
        const units = rows.reduce((sum, row) => { var _a; return sum + ((_a = soldBy.get(row.id)) !== null && _a !== void 0 ? _a : 0); }, 0);
        lines.push({
            key,
            title: named.title,
            supplierCode: (_d = (_c = newestFirst.find((row) => row.supplierCode.trim())) === null || _c === void 0 ? void 0 : _c.supplierCode.trim()) !== null && _d !== void 0 ? _d : "",
            ean: (_f = (_e = newestFirst.find((row) => row.ean.trim())) === null || _e === void 0 ? void 0 : _e.ean.trim()) !== null && _f !== void 0 ? _f : "",
            categoryPath: named.categoryPath,
            inStock,
            shelfTarget,
            sold: units,
            toOrder: unitsToOrder(inStock, shelfTarget),
            status: reorderStatus(inStock, shelfTarget),
            price: open.price,
            itemIds: rows.map((row) => row.id),
            sku: open.sku,
        });
    }
    return lines.sort((a, b) => b.toOrder - a.toOrder ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.title.localeCompare(b.title, "en-GB", { sensitivity: "base" }));
}
/** The figures across the top of the report. */
function reorderTotals(lines, requests) {
    return {
        products: lines.length,
        onTarget: lines.filter((line) => line.shelfTarget > 0).length,
        inStock: lines.reduce((sum, line) => sum + line.inStock, 0),
        sold: lines.reduce((sum, line) => sum + line.sold, 0),
        outOfStock: lines.filter((line) => line.status === "out").length,
        belowTarget: lines.filter((line) => line.status === "low").length,
        toOrder: lines.reduce((sum, line) => sum + line.toOrder, 0),
        openRequests: requests.filter((request) => isOpenRequest(request.status)).length,
    };
}
/** The last seven days ending on `today` (YYYY-MM-DD), both ends counted. */
function defaultReorderPeriod(today) {
    const end = new Date(`${today}T00:00:00Z`);
    const start = new Date(end.getTime() - 6 * 86400000);
    return { from: start.toISOString().slice(0, 10), to: today };
}
