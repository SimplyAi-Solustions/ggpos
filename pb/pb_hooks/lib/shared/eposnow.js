// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EPOS_STATUS_COMPLETE = void 0;
exports.eposTimestampToIso = eposTimestampToIso;
exports.readEposTransaction = readEposTransaction;
exports.eposTransactionsFrom = eposTransactionsFrom;
exports.normaliseProductIds = normaliseProductIds;
exports.guildSaleIn = guildSaleIn;
exports.isCompletedSale = isCompletedSale;
exports.splitName = splitName;
exports.eposCustomerBody = eposCustomerBody;
exports.eposCustomerIdFrom = eposCustomerIdFrom;
exports.eposCardNumberOf = eposCardNumberOf;
/**
 * Epos Now, read and written as plain data.
 *
 * The shop's till has been Epos Now since October 2026. GG Vault links its
 * own customers to Epos Now customers (the card number on the Epos Now side
 * is the customer's GGC code, so scanning the My Vault barcode at the till
 * attaches them) and activates a GG Guild membership when the till sells the
 * Guild product to a linked customer.
 *
 * Everything here is pure, so the hooks (through the CommonJS copy in
 * `pb/pb_hooks/lib/shared/`) and the Vitest suite read a transaction the same
 * way. Nothing here talks to the network.
 *
 * Two shapes reach us: the v4 REST API answers in camelCase (`customerId`,
 * `transactionItems`, `productId`), and a webhook may carry the older
 * PascalCase names (`CustomerID`, `TransactionItems`, `ProductID`). Every
 * key is therefore read case-insensitively and without underscores, so
 * either spelling lands in the same field.
 *
 * Amounts arrive as decimal pounds and leave as integer pence, through
 * `decimalPoundsToPence`. Timestamps carry no zone and are read as UTC.
 */
const money_1 = require("./money");
/** Epos Now's status for a completed sale (`TransactionStatus` 1). */
exports.EPOS_STATUS_COMPLETE = 1;
/** Epos Now's own field limits for a customer (v4 `CustomerCreateRequest`). */
const NAME_MAX = 50;
const EMAIL_MAX = 50;
const CARD_MAX = 50;
function isDict(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function squash(key) {
    return key.replace(/_/g, "").toLowerCase();
}
/** The first of `names` present on `obj`, matched without case or underscores. */
function pick(obj, ...names) {
    if (!isDict(obj))
        return undefined;
    const wanted = names.map(squash);
    for (const key of Object.keys(obj)) {
        if (wanted.includes(squash(key))) {
            const value = obj[key];
            if (value !== undefined)
                return value;
        }
    }
    return undefined;
}
/** An id as a string: Epos Now ids are integers, ours are compared as text. */
function idText(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return String(Math.trunc(value));
    if (typeof value === "string")
        return value.trim();
    return "";
}
function wholeNumber(value) {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n))
        return null;
    return Math.trunc(n);
}
/**
 * An Epos Now timestamp as ISO 8601 UTC. Epos Now writes them without a
 * zone (`2026-10-06T14:30:00` or with a space); those are read as UTC, as
 * agreed for this integration. One that does carry a zone keeps it.
 */
function eposTimestampToIso(value) {
    if (typeof value !== "string")
        return null;
    let text = value.trim();
    if (!text)
        return null;
    text = text.replace(" ", "T");
    const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
    if (!hasZone && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)) {
        text = text.includes("T") ? `${text}Z` : `${text}T00:00:00Z`;
    }
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed))
        return null;
    return new Date(parsed).toISOString();
}
function readLine(raw) {
    var _a, _b, _c;
    if (!isDict(raw))
        return null;
    const productId = idText(pick(raw, "productId", "product_id"));
    if (!productId)
        return null;
    const quantity = (_a = wholeNumber(pick(raw, "quantity", "qty"))) !== null && _a !== void 0 ? _a : 1;
    const unitPence = (_b = (0, money_1.decimalPoundsToPence)(pick(raw, "unitPrice", "price"))) !== null && _b !== void 0 ? _b : 0;
    const discountPence = (_c = (0, money_1.decimalPoundsToPence)(pick(raw, "discountAmount", "discount"))) !== null && _c !== void 0 ? _c : 0;
    const amountPence = Math.max(0, unitPence * quantity - Math.max(0, discountPence));
    return { productId, quantity, unitPence, discountPence, amountPence };
}
/**
 * One transaction in either spelling, or null when it has no id (nothing
 * idempotent can be done with a sale that cannot be named).
 */
function readEposTransaction(raw) {
    if (!isDict(raw))
        return null;
    const id = idText(pick(raw, "id", "transactionId"));
    if (!id)
        return null;
    const itemsRaw = pick(raw, "transactionItems", "items");
    const lines = [];
    if (Array.isArray(itemsRaw)) {
        for (const item of itemsRaw) {
            const line = readLine(item);
            if (line)
                lines.push(line);
        }
    }
    const customerRaw = idText(pick(raw, "customerId"));
    return {
        id,
        // 0 is what some Epos Now payloads send for "no customer".
        customerId: customerRaw === "0" ? "" : customerRaw,
        soldAt: eposTimestampToIso(pick(raw, "dateTime", "date", "transactionDate")),
        statusId: wholeNumber(pick(raw, "statusId", "status")),
        lines,
    };
}
/**
 * Every transaction in a payload: a bare array (the v4 list routes), a
 * single transaction (a webhook), or either of those inside a wrapper
 * object (`{ Data: ... }`, `{ Transaction: ... }`, `{ Transactions: [...] }`).
 */
function eposTransactionsFrom(payload) {
    if (Array.isArray(payload)) {
        const out = [];
        for (const entry of payload) {
            const tx = readEposTransaction(entry);
            if (tx)
                out.push(tx);
        }
        return out;
    }
    if (!isDict(payload))
        return [];
    const direct = readEposTransaction(payload);
    if (direct && (direct.lines.length > 0 || pick(payload, "transactionItems") !== undefined)) {
        return [direct];
    }
    const wrapped = pick(payload, "data", "transaction", "transactions", "payload", "object");
    if (wrapped !== undefined)
        return eposTransactionsFrom(wrapped);
    return direct ? [direct] : [];
}
/** Product ids as the strings `EposLine.productId` carries. */
function normaliseProductIds(ids) {
    if (!Array.isArray(ids))
        return [];
    const out = [];
    for (const id of ids) {
        const text = idText(id);
        if (text && !out.includes(text))
            out.push(text);
    }
    return out;
}
/**
 * The Guild product lines in a transaction, added up, or null when it sold
 * none. A line with a quantity of 0 or less is a refund or a void, not a
 * sale, and is left out.
 */
function guildSaleIn(tx, productIds) {
    const wanted = normaliseProductIds(productIds);
    if (wanted.length === 0)
        return null;
    let quantity = 0;
    let amountPence = 0;
    for (const line of tx.lines) {
        if (!wanted.includes(line.productId) || line.quantity <= 0)
            continue;
        quantity += line.quantity;
        amountPence += line.amountPence;
    }
    return quantity > 0 ? { quantity, amountPence } : null;
}
/** A completed sale, or one whose payload did not say (a completion webhook). */
function isCompletedSale(tx) {
    return tx.statusId === null || tx.statusId === exports.EPOS_STATUS_COMPLETE;
}
/** "Sam de la Cruz" as `{ forename: "Sam", surname: "de la Cruz" }`, within Epos Now's limits. */
function splitName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    const forename = (parts.shift() || "Customer").slice(0, NAME_MAX);
    const surname = parts.join(" ").slice(0, NAME_MAX);
    return { forename, surname };
}
/**
 * The body for `POST v4/Customer`, which takes an array. Only the fields
 * GG Vault means to share: the name, the email address, the card number
 * (the customer code) and the email marketing choice. No phone number,
 * address or date of birth leaves GG Vault.
 */
function eposCustomerBody(input) {
    const { forename, surname } = splitName(input.name);
    const email = String(input.email || "").trim();
    const body = {
        forename,
        cardNumber: String(input.code || "").slice(0, CARD_MAX),
        marketingConsent: { email: Boolean(input.marketingConsent), text: false, phone: false, mail: false },
    };
    if (surname)
        body.surname = surname;
    if (email && email.length <= EMAIL_MAX)
        body.emailAddress = email;
    if (input.locationId)
        body.signUpLocationId = input.locationId;
    if (input.signUpDate)
        body.signUpDate = input.signUpDate;
    return [body];
}
/** The Epos Now customer id out of a create or lookup answer, or "". */
function eposCustomerIdFrom(payload) {
    const first = Array.isArray(payload) ? payload[0] : payload;
    return idText(pick(first, "id", "customerId"));
}
/** The card number on an Epos Now customer record, or "". */
function eposCardNumberOf(payload) {
    const first = Array.isArray(payload) ? payload[0] : payload;
    const value = pick(first, "cardNumber");
    return typeof value === "string" ? value.trim() : "";
}
