// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MARKUP_BANDS = exports.DEFAULT_OFFER_SETTINGS = exports.DEFAULT_CONDITION_MULTIPLIERS = exports.DEFAULT_FRESHNESS = exports.DEFAULT_RETRO_PRIORITY = exports.DEFAULT_TCG_PRIORITY = void 0;
exports.chooseMarketPrice = chooseMarketPrice;
exports.adjustForCondition = adjustForCondition;
exports.isWildcard = isWildcard;
exports.isOpenEndedBand = isOpenEndedBand;
exports.selectRule = selectRule;
exports.computeOffer = computeOffer;
exports.suggestSellPrice = suggestSellPrice;
/**
 * Valuation and offer maths shared by the web app (previews), the PocketBase
 * hooks (the record of truth) and pricesync. Pure functions, pence in, pence out.
 */
const money_1 = require("./money");
exports.DEFAULT_TCG_PRIORITY = [
    "uk_sold_manual",
    "ebay_uk_asking",
    "cardmarket",
    "tcgplayer",
];
exports.DEFAULT_RETRO_PRIORITY = [
    "uk_sold_manual",
    "pricecharting_pal",
    "ebay_uk_asking",
    "pricecharting_ntsc",
];
exports.DEFAULT_FRESHNESS = {
    maxAgeHours: {
        uk_sold_manual: 30 * 24,
        ebay_uk_asking: 48,
        cardmarket: 72,
        tcgplayer: 72,
        pricecharting_pal: 72,
        pricecharting_ntsc: 72,
    },
};
/**
 * Pick the first fresh candidate in priority order. Stale candidates are
 * reported but skipped; if nothing is fresh, the freshest stale candidate wins
 * so staff still see a number, marked stale by the caller.
 */
function chooseMarketPrice(candidates, priority, now, freshness = exports.DEFAULT_FRESHNESS) {
    const considered = [];
    let chosen = null;
    for (const source of priority) {
        const matches = candidates
            .filter((c) => c.source === source)
            .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
        const candidate = matches[0];
        if (!candidate)
            continue;
        const maxAge = freshness.maxAgeHours[source];
        const ageHours = (now.getTime() - new Date(candidate.fetchedAt).getTime()) / 36e5;
        const stale = maxAge !== undefined && ageHours > maxAge;
        if (!stale && !chosen) {
            chosen = candidate;
            considered.push({ candidate, status: "chosen" });
        }
        else {
            considered.push({ candidate, status: stale ? "stale" : "skipped" });
        }
    }
    if (!chosen) {
        const freshest = [...candidates].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0];
        if (freshest)
            chosen = freshest;
    }
    return { chosen, considered };
}
exports.DEFAULT_CONDITION_MULTIPLIERS = {
    NM: 1,
    LP: 0.85,
    MP: 0.7,
    HP: 0.5,
    DMG: 0.3,
};
/** Market value adjusted for condition, half-up to the penny. */
function adjustForCondition(gbpMarket, condition, multipliers = exports.DEFAULT_CONDITION_MULTIPLIERS) {
    return (0, money_1.roundHalfUp)(gbpMarket * multipliers[condition]);
}
/** True when a rule's optional field ("", null or undefined) should match any value. */
function isWildcard(value) {
    return value === null || value === undefined || value === "";
}
/** True when a rule's band has no real upper bound - see PricingRule.bandMax. */
function isOpenEndedBand(bandMax) {
    return bandMax === null || bandMax === 0;
}
/**
 * Select the most specific active rule for the context and adjusted market
 * value. Specificity counts matched optional fields; ties break on priority
 * (higher first), then on the narrower band.
 */
function selectRule(rules, ctx, adjustedMarket) {
    const matches = rules.filter((r) => {
        var _a, _b;
        if (!r.active)
            return false;
        if (adjustedMarket < r.bandMin)
            return false;
        if (!isOpenEndedBand(r.bandMax) && adjustedMarket >= r.bandMax)
            return false;
        if (!isWildcard(r.game) && r.game !== ctx.game)
            return false;
        if (!isWildcard(r.kind) && r.kind !== ctx.kind)
            return false;
        if (!isWildcard(r.condition) && r.condition !== ctx.condition)
            return false;
        if (!isWildcard(r.finish) && r.finish !== ((_a = ctx.finish) !== null && _a !== void 0 ? _a : null))
            return false;
        if (!isWildcard(r.rarity) && r.rarity !== ((_b = ctx.rarity) !== null && _b !== void 0 ? _b : null))
            return false;
        return true;
    });
    if (matches.length === 0)
        return null;
    const specificity = (r) => [r.game, r.kind, r.condition, r.finish, r.rarity].filter((v) => !isWildcard(v)).length;
    const bandWidth = (r) => isOpenEndedBand(r.bandMax) ? Number.POSITIVE_INFINITY : r.bandMax - r.bandMin;
    return matches.sort((a, b) => specificity(b) - specificity(a) ||
        b.priority - a.priority ||
        bandWidth(a) - bandWidth(b))[0];
}
exports.DEFAULT_OFFER_SETTINGS = {
    bulkThreshold: 100,
    bulkCash: 5,
    bulkCredit: 10,
    minimumOffer: 25,
};
/** Full offer computation for one line. */
function computeOffer(gbpMarket, ctx, rules, settings = exports.DEFAULT_OFFER_SETTINGS, multipliers = exports.DEFAULT_CONDITION_MULTIPLIERS) {
    const condition = ctx.condition;
    const adjustedMarket = condition in multipliers ? adjustForCondition(gbpMarket, condition, multipliers) : gbpMarket;
    if (adjustedMarket <= settings.bulkThreshold) {
        return {
            cash: settings.bulkCash,
            credit: settings.bulkCredit,
            cashPct: 0,
            creditPct: 0,
            rule: null,
            bulk: true,
            adjustedMarket,
        };
    }
    const rule = selectRule(rules, ctx, adjustedMarket);
    if (!rule) {
        return { cash: 0, credit: 0, cashPct: 0, creditPct: 0, rule: null, bulk: false, adjustedMarket };
    }
    const cash = Math.max(settings.minimumOffer, (0, money_1.roundToStep)((0, money_1.applyPercent)(adjustedMarket, rule.cashPct), rule.rounding));
    const credit = Math.max(settings.minimumOffer, (0, money_1.roundToStep)((0, money_1.applyPercent)(adjustedMarket, rule.creditPct), rule.rounding));
    return { cash, credit, cashPct: rule.cashPct, creditPct: rule.creditPct, rule, bulk: false, adjustedMarket };
}
exports.DEFAULT_MARKUP_BANDS = [
    { from: 0, multiplier: 1.1 },
    { from: 500, multiplier: 1.05 },
    { from: 5000, multiplier: 1.0 },
];
function suggestSellPrice(gbpMarket, bands = exports.DEFAULT_MARKUP_BANDS, ending = (p) => p) {
    var _a;
    const band = [...bands].sort((a, b) => b.from - a.from).find((b) => gbpMarket >= b.from);
    const raw = (0, money_1.roundHalfUp)(gbpMarket * ((_a = band === null || band === void 0 ? void 0 : band.multiplier) !== null && _a !== void 0 ? _a : 1));
    return ending(raw);
}
