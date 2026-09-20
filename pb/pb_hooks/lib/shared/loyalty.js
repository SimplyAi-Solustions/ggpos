// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTierPerk = parseTierPerk;
exports.evaluateSalePoints = evaluateSalePoints;
exports.evaluateTradeInPoints = evaluateTradeInPoints;
exports.pointsToPence = pointsToPence;
exports.penceToPoints = penceToPoints;
exports.checkPointsRedemption = checkPointsRedemption;
exports.tierForPoints = tierForPoints;
exports.pointsToNextTier = pointsToNextTier;
exports.tierWindowPoints = tierWindowPoints;
exports.perkAllowance = perkAllowance;
exports.resolveTier = resolveTier;
/**
 * GG Guild loyalty evaluator. Pure functions so the admin preview in the app and
 * the PocketBase hook produce the same points for the same sale.
 */
const money_1 = require("./money");
/**
 * Runtime shape check for one loyalty_tiers.perks entry loaded from
 * PocketBase (plain JSON, so nothing guarantees it matches TierPerk).
 * Returns null when the shape does not match a known perk exactly - for
 * example the pre-fix seed's snake_case "per_month" or an "all"/string
 * scope instead of a string array - rather than silently misreading it.
 */
function parseTierPerk(value) {
    if (!value || typeof value !== "object")
        return null;
    const v = value;
    switch (v.type) {
        case "percent_off":
            return typeof v.value === "number" &&
                Array.isArray(v.scope) &&
                v.scope.every((s) => typeof s === "string")
                ? { type: "percent_off", value: v.value, scope: v.scope }
                : null;
        case "points_multiplier":
            return typeof v.value === "number" ? { type: "points_multiplier", value: v.value } : null;
        case "free_event_entries":
            return typeof v.value === "number" && v.perMonth === true
                ? { type: "free_event_entries", value: v.value, perMonth: true }
                : null;
        case "lounge_hours":
            return typeof v.value === "number" && v.perMonth === true
                ? { type: "lounge_hours", value: v.value, perMonth: true }
                : null;
        case "priority_release_booking":
            return { type: "priority_release_booking" };
        case "member_event_pricing":
            return { type: "member_event_pricing" };
        default:
            return null;
    }
}
function ruleIsLive(rule, at) {
    if (!rule.active)
        return false;
    if (rule.startsAt && new Date(rule.startsAt) > at)
        return false;
    if (rule.endsAt && new Date(rule.endsAt) < at)
        return false;
    return true;
}
function lineMatches(line, c) {
    if (c.games && c.games.length > 0 && (!line.game || !c.games.includes(line.game)))
        return false;
    if (c.kinds && c.kinds.length > 0 && !c.kinds.includes(line.kind))
        return false;
    return true;
}
/**
 * Points earned on a sale: base points per pound on the eligible spend (spend
 * paid with points earns nothing), then rules in priority order (multipliers
 * stack multiplicatively on matching lines, bonuses add once), then the tier
 * multiplier. Result is rounded half-up.
 */
function evaluateSalePoints(programme, rules, ctx) {
    var _a, _b, _c;
    if (!programme.enabled)
        return { base: 0, ruleAdjustments: [], tierMultiplier: 1, total: 0 };
    const gross = ctx.lines.reduce((s, l) => s + l.total, 0);
    const eligibleShare = gross > 0 ? Math.max(0, gross - ctx.paidWithPoints) / gross : 0;
    const live = rules.filter((r) => ruleIsLive(r, ctx.at)).sort((a, b) => b.priority - a.priority);
    let base = 0;
    const perLine = ctx.lines.map((line) => {
        const pounds = (line.total * eligibleShare) / 100;
        let points = pounds * programme.earnPerPoundSales;
        base += points;
        return { line, points };
    });
    const ruleAdjustments = [];
    for (const rule of live) {
        const c = rule.conditions;
        if (c.minSpend !== undefined && gross < c.minSpend)
            continue;
        switch (rule.type) {
            case "multiplier":
            case "day_of_week": {
                if (rule.type === "day_of_week" && c.weekdays && !c.weekdays.includes(ctx.at.getDay()))
                    break;
                if (rule.type === "multiplier" && c.weekdays && c.weekdays.length > 0 && !c.weekdays.includes(ctx.at.getDay()))
                    break;
                let delta = 0;
                for (const entry of perLine) {
                    if (!lineMatches(entry.line, c))
                        continue;
                    const before = entry.points;
                    entry.points = before * rule.value;
                    delta += entry.points - before;
                }
                if (delta !== 0)
                    ruleAdjustments.push({ rule, delta });
                break;
            }
            case "fixed_bonus": {
                if (ctx.lines.some((l) => lineMatches(l, c)))
                    ruleAdjustments.push({ rule, delta: rule.value });
                break;
            }
            case "first_purchase": {
                if (ctx.isFirstPurchase)
                    ruleAdjustments.push({ rule, delta: rule.value });
                break;
            }
            case "birthday_month": {
                if (ctx.isBirthdayMonth)
                    ruleAdjustments.push({ rule, delta: rule.value });
                break;
            }
            case "trade_in_credit_bonus":
            case "event_checkin":
                // Not sale rules; handled by evaluateTradeInPoints and check-in flows.
                break;
        }
    }
    const afterRules = perLine.reduce((s, e) => s + e.points, 0) +
        ruleAdjustments.filter((a) => a.rule.type !== "multiplier" && a.rule.type !== "day_of_week").reduce((s, a) => s + a.delta, 0);
    const tierMultiplier = (_c = (_b = (_a = ctx.tier) === null || _a === void 0 ? void 0 : _a.perks.find((p) => p.type === "points_multiplier")) === null || _b === void 0 ? void 0 : _b.value) !== null && _c !== void 0 ? _c : 1;
    const total = (0, money_1.roundHalfUp)(afterRules * tierMultiplier);
    return { base: (0, money_1.roundHalfUp)(base), ruleAdjustments, tierMultiplier, total };
}
/** Points earned on the credit portion of a trade-in, plus any credit bonus rules. */
function evaluateTradeInPoints(programme, rules, creditPence, at) {
    if (!programme.enabled || creditPence <= 0)
        return 0;
    let points = (creditPence / 100) * programme.earnPerPoundTradeInCredit;
    for (const rule of rules.filter((r) => ruleIsLive(r, at) && r.type === "trade_in_credit_bonus")) {
        if (rule.conditions.minSpend !== undefined && creditPence < rule.conditions.minSpend)
            continue;
        points += rule.value;
    }
    return (0, money_1.roundHalfUp)(points);
}
/** Value of points in pence at the programme rate. */
function pointsToPence(points, programme) {
    return (0, money_1.roundHalfUp)((points / programme.pointsPerPoundRedemption) * 100);
}
/** Points needed to cover a pence amount (rounded up to whole points). */
function penceToPoints(pence, programme) {
    return Math.ceil((pence / 100) * programme.pointsPerPoundRedemption);
}
/** Can this customer pay `points` towards a sale of `saleTotal` pence? */
function checkPointsRedemption(programme, balance, points, saleTotal) {
    const maxPence = (0, money_1.roundHalfUp)((saleTotal * programme.maxPointsShareOfSale) / 100);
    const maxPointsForSale = Math.min(balance, penceToPoints(maxPence, programme));
    if (!programme.enabled)
        return { ok: false, reason: "disabled", maxPointsForSale: 0 };
    if (points < programme.minRedeemPoints)
        return { ok: false, reason: "below_minimum", maxPointsForSale };
    if (points > balance)
        return { ok: false, reason: "insufficient", maxPointsForSale };
    if (points > maxPointsForSale)
        return { ok: false, reason: "over_share", maxPointsForSale };
    return { ok: true, reason: "ok", maxPointsForSale };
}
/** Tier for a rolling-window points total; paid plans are pinned by the caller. */
function tierForPoints(tiers, windowPoints) {
    var _a;
    const earned = tiers.filter((t) => !t.paidPlan).sort((a, b) => b.thresholdPoints - a.thresholdPoints);
    return (_a = earned.find((t) => windowPoints >= t.thresholdPoints)) !== null && _a !== void 0 ? _a : null;
}
/** Points to the next tier, or null at the top. */
function pointsToNextTier(tiers, windowPoints) {
    const next = tiers
        .filter((t) => !t.paidPlan && t.thresholdPoints > windowPoints)
        .sort((a, b) => a.thresholdPoints - b.thresholdPoints)[0];
    return next ? { tier: next, points: next.thresholdPoints - windowPoints } : null;
}
/** Reasons that never count towards a tier: spending points must not cost a tier. */
const TIER_WINDOW_EXCLUDED_REASONS = ["redeem", "expire"];
/**
 * PocketBase stores a date as "2026-09-20 12:00:00.000Z" (a space, not the
 * ISO "T"), which not every JS engine parses. Normalising the separator
 * first means the same row reads the same in the browser, in Vitest and in
 * goja.
 */
function parseLedgerDate(value) {
    if (!value)
        return null;
    const parsed = new Date(String(value).trim().replace(" ", "T"));
    return isNaN(parsed.getTime()) ? null : parsed;
}
/** `at` minus `months` calendar months, clamped to the end of the target month. */
function monthsBefore(at, months) {
    const d = new Date(at.getTime());
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
}
/**
 * Points counted towards a tier: every ledger row created inside the last
 * `windowMonths` calendar months, except the rows that only ever move points
 * out again (`redeem`, `expire`). Spending points, or letting them expire,
 * never costs a tier; a `refund_reverse` or a negative `adjust` does count
 * against it, because both undo something that earned the tier in the first
 * place. `windowMonths` of 0 (or less) means all time.
 */
function tierWindowPoints(rows, now, windowMonths) {
    const start = windowMonths > 0 ? monthsBefore(now, windowMonths) : null;
    let total = 0;
    for (const row of rows || []) {
        if (!row)
            continue;
        if (TIER_WINDOW_EXCLUDED_REASONS.indexOf(row.reason) >= 0)
            continue;
        if (start) {
            const at = parseLedgerDate(row.created);
            if (!at || at.getTime() < start.getTime())
                continue;
        }
        total += Math.round(row.delta || 0);
    }
    return total;
}
/** A tier's monthly allowance for a counted perk, 0 when the tier has none. */
function perkAllowance(tier, type) {
    if (!tier)
        return 0;
    for (const perk of tier.perks || []) {
        if (perk && perk.type === type)
            return perk.value || 0;
    }
    return 0;
}
/**
 * The tier a customer is actually on: a paid plan pins it for as long as the
 * membership is active, whatever the window says; otherwise it is earned from
 * the window's own points.
 *
 * An `activeMembershipTierId` naming a tier that no longer exists falls back
 * to the earned tier rather than leaving the customer with none.
 */
function resolveTier(tiers, windowPoints, activeMembershipTierId) {
    if (activeMembershipTierId) {
        const pinned = (tiers || []).find((t) => t && t.id === activeMembershipTierId);
        if (pinned)
            return pinned;
    }
    return tierForPoints(tiers, windowPoints);
}
