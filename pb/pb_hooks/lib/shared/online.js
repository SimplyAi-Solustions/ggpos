// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLIC_ORIGINS = exports.PUBLIC_SEARCH_MAX = exports.PUBLIC_STOCK_PER_PAGE = exports.DEFAULT_ONLINE_SETTINGS = void 0;
exports.readOnlineSettings = readOnlineSettings;
exports.onlineProblem = onlineProblem;
exports.isOnline = isOnline;
exports.conditionLabel = conditionLabel;
exports.ratioOf = ratioOf;
/**
 * Stock on the website (docs/EPOS-PLAN.md, decision 13;
 * docs/api-contract-launch.md, section 6).
 *
 * The shop's website reads GG Vault's public feed in the browser: items in
 * stock that staff have marked `show_online`, never a cost, a supplier, a
 * customer, a location or a note. This module is the one place the rule
 * for "is it on the website" lives, so the feed on the server
 * (pb/pb_hooks/lib/publicstock.js) and the line on the item page agree,
 * and the shapes the feed answers with.
 *
 * Pure and shared: no PocketBase, no DOM.
 */
const money_1 = require("./money");
exports.DEFAULT_ONLINE_SETTINGS = {
    enabled: true,
    min_price: 0,
    hide_qty: false,
};
/** Items on one page of `GET /api/public/stock`. */
exports.PUBLIC_STOCK_PER_PAGE = 24;
/** Longest search the feed takes; anything past it is cut. */
exports.PUBLIC_SEARCH_MAX = 80;
/** The website's two origins: the only ones `/api/public/` answers cross-origin reads for. */
exports.PUBLIC_ORIGINS = [
    "https://ggentertainment.co.uk",
    "https://www.ggentertainment.co.uk",
];
/** `settings.online` as stored (json, possibly empty or partial), made whole. */
function readOnlineSettings(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const min = Number(value.min_price);
    return {
        enabled: value.enabled === undefined ? exports.DEFAULT_ONLINE_SETTINGS.enabled : value.enabled === true,
        min_price: Number.isFinite(min) && min > 0 ? Math.round(min) : 0,
        hide_qty: value.hide_qty === true,
    };
}
/**
 * Why an item is not on the website, or null when it is. In this order: the
 * feed switched off, not marked, not on the shelf (sold, reserved, written
 * off), none left, priced under the floor.
 */
function onlineProblem(item, settings) {
    var _a, _b;
    if (!settings.enabled)
        return "The website feed is switched off in Settings, Website.";
    if (!item.show_online)
        return "Not shown on the website.";
    const status = item.status || "in_stock";
    if (status === "sold")
        return "Sold, so it is off the website.";
    if (status === "reserved")
        return "Reserved, so it is off the website until the hold ends.";
    if (status !== "in_stock")
        return "Only stock on the shelf shows on the website.";
    if (!(((_a = item.qty) !== null && _a !== void 0 ? _a : 0) > 0))
        return "None left on the shelf, so it is off the website.";
    if (((_b = item.price) !== null && _b !== void 0 ? _b : 0) < settings.min_price) {
        return `Under the website's minimum price of ${(0, money_1.formatGBP)(settings.min_price)}.`;
    }
    return null;
}
/** Whether the item is in the public feed right now. */
function isOnline(item, settings) {
    return onlineProblem(item, settings) === null;
}
const CARD_CONDITIONS = {
    NM: "Near mint",
    LP: "Lightly played",
    MP: "Moderately played",
    HP: "Heavily played",
    DMG: "Damaged",
};
const COMPLETENESS = {
    loose: "Loose",
    boxed: "Boxed",
    cib: "Complete in box",
};
/**
 * The condition in words a customer reads: a card's grade spelled out, a
 * slab's company and grade, a retro game's completeness, "Sealed" for
 * sealed product, and "" when nothing is recorded.
 */
function conditionLabel(item) {
    var _a, _b, _c, _d;
    if (item.kind === "graded") {
        const graded = [item.grade_company, item.grade].filter((part) => part && String(part).trim()).join(" ");
        return graded || "Graded";
    }
    if (item.kind === "retro")
        return (_b = COMPLETENESS[(_a = item.completeness) !== null && _a !== void 0 ? _a : ""]) !== null && _b !== void 0 ? _b : "";
    if (item.kind === "sealed")
        return "Sealed";
    return (_d = CARD_CONDITIONS[(_c = item.condition) !== null && _c !== void 0 ? _c : ""]) !== null && _d !== void 0 ? _d : "";
}
/**
 * A frame's ratio as one number, width over height to four places
 * (63:88 is 0.7159), so a page can set `aspect-ratio` straight from it.
 * A missing or broken ratio is the table's 3:4 fallback.
 */
function ratioOf(width, height) {
    if (!(width > 0) || !(height > 0))
        return 0.75;
    return Math.round((width / height) * 10000) / 10000;
}
