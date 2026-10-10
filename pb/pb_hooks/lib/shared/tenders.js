// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFUND_NEEDS_CUSTOMER = exports.NEEDS_CUSTOMER = exports.CARD_LAST4 = exports.PART_EXCHANGE_PANEL = exports.SUMUP_GONE = exports.REFUND_TENDERS = exports.MAX_TENDERS = void 0;
exports.sumProblem = sumProblem;
exports.changeDue = changeDue;
exports.amountDue = amountDue;
exports.paymentFor = paymentFor;
exports.splitFor = splitFor;
exports.toTender = toTender;
exports.checkSaleTenders = checkSaleTenders;
exports.checkRefundTenders = checkRefundTenders;
/**
 * How a sale is paid, and how a refund goes back (docs/api-contract-epos.md,
 * section 4).
 *
 * Pure and shared: the till runs these before it sends a sale or a refund,
 * and the server runs the same functions (through the generated copy in
 * pb/pb_hooks/lib/shared/tenders.js) before it writes anything, so the
 * counter and the server say the same sentence about the same mistake. The
 * server's answer is the one that counts; balances, the cash cap and the open
 * session are checked there against live records.
 *
 * Money is integer GBP pence. A tender's `amount` is what it puts against the
 * sale; only cash gives change, and the change is what was handed over less
 * that amount. The cash that stays in the drawer is the amount, never what
 * was handed over.
 */
const money_1 = require("./money");
const epos_types_1 = require("./epos-types");
/** The most tenders one sale or refund may carry. */
exports.MAX_TENDERS = 10;
/** The methods a refund can go back by. */
exports.REFUND_TENDERS = ["cash", "card_tide", "store_credit"];
exports.SUMUP_GONE = "SumUp is no longer used. Take card payments on the Tide reader.";
exports.PART_EXCHANGE_PANEL = "Take part-exchange through Trade in on the ticket.";
exports.CARD_LAST4 = "Key the last four digits of the card.";
exports.NEEDS_CUSTOMER = "Add the customer before using store credit or points.";
exports.REFUND_NEEDS_CUSTOMER = "This sale has no customer, so it cannot go back as store credit.";
const SALE_METHODS = ["cash", "card_tide", "store_credit", "points"];
function isEmpty(input) {
    return input === undefined || input === null || (Array.isArray(input) && input.length === 0);
}
function isWholePence(value) {
    return typeof value === "number" && Number.isInteger(value);
}
/** A text field off an untyped tender, trimmed; "" when absent. */
function textOf(value) {
    if (value === null || value === undefined)
        return "";
    return String(value).trim();
}
/** The sentence for the payments not adding up to the total. */
function sumProblem(paid, total) {
    return `The payments come to ${(0, money_1.formatGBP)(paid)} but the total is ${(0, money_1.formatGBP)(total)}.`;
}
/** Change due on a cash tender: what was handed over less what it pays, never below zero. */
function changeDue(tendered, amount) {
    return Math.max(0, tendered - amount);
}
/** What is still to pay once these tenders are taken; negative when they come to more. */
function amountDue(total, tenders) {
    return tenders.reduce((left, tender) => left - tender.amount, total);
}
/** `sales.payment` for a set of tenders: the one method, or "mixed". */
function paymentFor(tenders) {
    const methods = new Set(tenders.map((tender) => tender.method));
    if (methods.size === 1)
        return tenders[0].method;
    return "mixed";
}
/**
 * `sales.payment_split` mirrored from the tenders, for reports written before
 * tenders existed. The four original keys are always present (`sumup_card`
 * at 0 on every new sale); any other method appears when it was used.
 */
function splitFor(tenders) {
    var _a;
    const split = { sumup_card: 0, cash: 0, store_credit: 0, points: 0, card_tide: 0 };
    for (const tender of tenders) {
        split[tender.method] = ((_a = split[tender.method]) !== null && _a !== void 0 ? _a : 0) + tender.amount;
    }
    return split;
}
/** A stored or checked tender as the routes return it, with its label. */
function toTender(row) {
    var _a, _b, _c, _d, _e;
    return {
        method: row.method,
        label: (_a = epos_types_1.TENDER_LABELS[row.method]) !== null && _a !== void 0 ? _a : row.method,
        amount: row.amount,
        tendered: (_b = row.tendered) !== null && _b !== void 0 ? _b : 0,
        change: (_c = row.change) !== null && _c !== void 0 ? _c : 0,
        card_last4: (_d = row.card_last4) !== null && _d !== void 0 ? _d : "",
        reference: (_e = row.reference) !== null && _e !== void 0 ? _e : "",
    };
}
/** The card fields common to a sale and a refund: last four digits and a reference. */
function cardFields(raw, requireLast4) {
    const last4 = textOf(raw.card_last4);
    if ((requireLast4 || last4 !== "") && !/^\d{4}$/.test(last4)) {
        return { ok: false, message: exports.CARD_LAST4 };
    }
    const reference = textOf(raw.reference);
    if (reference.length > 60) {
        return { ok: false, message: "Keep the card reference to 60 characters." };
    }
    return { ok: true, last4, reference };
}
/**
 * The tenders for a sale against the contract's rules: every tender a known
 * till method with an amount above zero, at most one cash tender, cash
 * handed over at least what it pays, change from cash only, the card's last
 * four digits when the shop asks for them, a customer for store credit and
 * points, and the whole lot summing to the total exactly.
 */
function checkSaleTenders(input, rules) {
    // A sale that comes to nothing (a reward or a perk covering all of it)
    // takes no payment at all.
    if (rules.total === 0 && isEmpty(input)) {
        return { ok: true, tenders: [], paid: 0, change: 0, cash: 0 };
    }
    if (!Array.isArray(input) || input.length === 0) {
        return { ok: false, code: "invalid", message: "Add how the customer is paying." };
    }
    if (input.length > exports.MAX_TENDERS) {
        return {
            ok: false,
            code: "invalid",
            message: `A sale can take up to ${exports.MAX_TENDERS} payments. Put some of them together.`,
        };
    }
    const tenders = [];
    let cashSeen = false;
    let paid = 0;
    let change = 0;
    let cash = 0;
    for (const entry of input) {
        const raw = (entry && typeof entry === "object" ? entry : {});
        const method = textOf(raw.method);
        if (method === "sumup_card")
            return { ok: false, code: "invalid", message: exports.SUMUP_GONE };
        if (method === "part_exchange")
            return { ok: false, code: "invalid", message: exports.PART_EXCHANGE_PANEL };
        if (!SALE_METHODS.includes(method)) {
            return {
                ok: false,
                code: "invalid",
                message: "Pick how the customer is paying: cash, card, store credit or points.",
            };
        }
        const amount = raw.amount;
        if (!isWholePence(amount) || amount <= 0) {
            return { ok: false, code: "invalid", message: `Each payment needs an amount above ${(0, money_1.formatGBP)(0)}.` };
        }
        let tendered = amount;
        let changeHere = 0;
        let last4 = "";
        let reference = "";
        if (method === "cash") {
            if (cashSeen) {
                return {
                    ok: false,
                    code: "invalid",
                    message: "There are two cash payments. Put the cash together as one payment.",
                };
            }
            cashSeen = true;
            if (raw.tendered !== undefined && raw.tendered !== null) {
                if (!isWholePence(raw.tendered) || raw.tendered < amount) {
                    const handed = isWholePence(raw.tendered) ? (0, money_1.formatGBP)(raw.tendered) : "The cash handed over";
                    return {
                        ok: false,
                        code: "invalid",
                        message: `${handed} does not cover the ${(0, money_1.formatGBP)(amount)} cash payment. Key what the customer handed over.`,
                    };
                }
                tendered = raw.tendered;
            }
            changeHere = changeDue(tendered, amount);
            cash = amount;
        }
        else {
            if (raw.tendered !== undefined && raw.tendered !== null && raw.tendered !== amount) {
                return {
                    ok: false,
                    code: "invalid",
                    message: "Only cash gives change. Key the exact amount for every other payment.",
                };
            }
            if (method === "card_tide") {
                const card = cardFields(raw, rules.requireCardLast4);
                if (!card.ok)
                    return { ok: false, code: "invalid", message: card.message };
                last4 = card.last4;
                reference = card.reference;
            }
            if ((method === "store_credit" || method === "points") && !rules.hasCustomer) {
                return { ok: false, code: "needs_customer", message: exports.NEEDS_CUSTOMER };
            }
        }
        paid += amount;
        change += changeHere;
        tenders.push({
            method: method,
            amount,
            tendered,
            change: changeHere,
            card_last4: last4,
            reference,
        });
    }
    if (paid !== rules.total) {
        return { ok: false, code: "invalid", message: sumProblem(paid, rules.total) };
    }
    return { ok: true, tenders, paid, change, cash };
}
/**
 * The tenders for a refund: cash, the Tide card or store credit, each above
 * zero, at most one cash tender, and together exactly the refund amount. A
 * card refund is keyed on the Tide reader by hand; its last four digits are
 * optional, but checked when given. `amount` on the way in is positive (what
 * goes back); the server stores it negative.
 */
function checkRefundTenders(input, rules) {
    // Lines that came to nothing (fully discounted) go back with no money.
    if (rules.amount === 0 && isEmpty(input)) {
        return { ok: true, tenders: [], paid: 0, change: 0, cash: 0 };
    }
    if (!Array.isArray(input) || input.length === 0) {
        return {
            ok: false,
            code: "invalid",
            message: "Say how the refund is going back: cash, card or store credit.",
        };
    }
    if (input.length > exports.MAX_TENDERS) {
        return {
            ok: false,
            code: "invalid",
            message: `A refund can go back in up to ${exports.MAX_TENDERS} payments. Put some of them together.`,
        };
    }
    const tenders = [];
    let cashSeen = false;
    let paid = 0;
    let cash = 0;
    for (const entry of input) {
        const raw = (entry && typeof entry === "object" ? entry : {});
        const method = textOf(raw.method);
        if (method === "sumup_card") {
            return {
                ok: false,
                code: "invalid",
                message: "SumUp is no longer used. Refund card payments on the Tide reader.",
            };
        }
        if (!exports.REFUND_TENDERS.includes(method)) {
            return {
                ok: false,
                code: "invalid",
                message: "Say how the refund is going back: cash, card or store credit.",
            };
        }
        const amount = raw.amount;
        if (!isWholePence(amount) || amount <= 0) {
            return { ok: false, code: "invalid", message: `Each payment back needs an amount above ${(0, money_1.formatGBP)(0)}.` };
        }
        let last4 = "";
        let reference = "";
        if (method === "cash") {
            if (cashSeen) {
                return {
                    ok: false,
                    code: "invalid",
                    message: "There are two cash payments back. Put the cash together as one payment.",
                };
            }
            cashSeen = true;
            cash = amount;
        }
        else if (method === "card_tide") {
            const card = cardFields(raw, false);
            if (!card.ok)
                return { ok: false, code: "invalid", message: card.message };
            last4 = card.last4;
            reference = card.reference;
        }
        else if (!rules.hasCustomer) {
            return { ok: false, code: "needs_customer", message: exports.REFUND_NEEDS_CUSTOMER };
        }
        paid += amount;
        tenders.push({
            method: method,
            amount,
            tendered: 0,
            change: 0,
            card_last4: last4,
            reference,
        });
    }
    if (paid !== rules.amount) {
        return {
            ok: false,
            code: "invalid",
            message: `The payments back come to ${(0, money_1.formatGBP)(paid)} but the refund is ${(0, money_1.formatGBP)(rules.amount)}.`,
        };
    }
    return { ok: true, tenders, paid, change: 0, cash };
}
