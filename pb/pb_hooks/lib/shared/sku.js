// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * Codes printed on labels and cards.
 *
 * Shape: "GG" + kind letter + 5 body characters + 1 check character, all from
 * the Crockford base32 alphabet (no I, L, O, U). Displayed with a hyphen after
 * the kind letter (GGS-7F3K2Q), encoded in QR codes without it (GGS7F3K2Q).
 *
 * Kind letters: S single, G graded, R retro, P sealed product, A accessory,
 * X other, C customer, V reward voucher. The scan listener routes by kind.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODE_KINDS = exports.CROCKFORD_ALPHABET = void 0;
exports.computeCheckChar = computeCheckChar;
exports.normaliseCode = normaliseCode;
exports.kindFromLetter = kindFromLetter;
exports.parseCode = parseCode;
exports.isValidCode = isValidCode;
exports.buildCode = buildCode;
exports.generateCode = generateCode;
exports.displayCode = displayCode;
exports.encodeCode = encodeCode;
exports.CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
exports.CODE_KINDS = {
    single: "S",
    graded: "G",
    retro: "R",
    sealed: "P",
    accessory: "A",
    other: "X",
    customer: "C",
    voucher: "V",
};
const KIND_LETTERS = new Set(Object.values(exports.CODE_KINDS));
const BODY_LENGTH = 5;
const PREFIX = "GG";
function valueOf(char) {
    const index = exports.CROCKFORD_ALPHABET.indexOf(char);
    if (index < 0)
        throw new Error(`Character not in alphabet: ${char}`);
    return index;
}
/**
 * Weighted mod-32 check over kind letter + body. Weights rise with position so
 * an adjacent transposition changes the result.
 */
function computeCheckChar(letter, body) {
    const chars = letter + body;
    let sum = 0;
    for (let i = 0; i < chars.length; i++) {
        sum += valueOf(chars[i]) * (i + 1);
    }
    return exports.CROCKFORD_ALPHABET[sum % 32];
}
/**
 * Normalise scanned or typed input: uppercase, drop hyphens and spaces, and
 * apply Crockford's decode rules (I and L read as 1, O reads as 0).
 */
function normaliseCode(input) {
    return input
        .trim()
        .toUpperCase()
        .replace(/[-\s]/g, "")
        .replace(/[IL]/g, "1")
        .replace(/O/g, "0");
}
function kindFromLetter(letter) {
    const entry = Object.entries(exports.CODE_KINDS).find(([, l]) => l === letter);
    return entry ? entry[0] : null;
}
/** Parse and validate a code. Returns null when the shape or check fails. */
function parseCode(input) {
    const encoded = normaliseCode(input);
    if (encoded.length !== PREFIX.length + 1 + BODY_LENGTH + 1)
        return null;
    if (!encoded.startsWith(PREFIX))
        return null;
    const letter = encoded[2];
    if (!KIND_LETTERS.has(letter))
        return null;
    const body = encoded.slice(3, 3 + BODY_LENGTH);
    const check = encoded[3 + BODY_LENGTH];
    for (const ch of body + check) {
        if (!exports.CROCKFORD_ALPHABET.includes(ch))
            return null;
    }
    if (computeCheckChar(letter, body) !== check)
        return null;
    const kind = kindFromLetter(letter);
    if (!kind)
        return null;
    return {
        kind,
        letter: letter,
        body,
        check,
        encoded,
        display: `${PREFIX}${letter}-${body}${check}`,
    };
}
function isValidCode(input) {
    return parseCode(input) !== null;
}
/** Build a code from a kind and a 5-character body (adds the check character). */
function buildCode(kind, body) {
    if (body.length !== BODY_LENGTH)
        throw new Error(`Body must be ${BODY_LENGTH} characters`);
    const letter = exports.CODE_KINDS[kind];
    const check = computeCheckChar(letter, body);
    const parsed = parseCode(`${PREFIX}${letter}${body}${check}`);
    if (!parsed)
        throw new Error("Built code failed to parse");
    return parsed;
}
/**
 * Generate a random code of a kind using the supplied random source
 * (defaults to crypto.getRandomValues; hooks pass their own source).
 */
function generateCode(kind, randomByte = defaultRandomByte) {
    let body = "";
    while (body.length < BODY_LENGTH) {
        const byte = randomByte();
        // 256 is a multiple of 32, so masking gives a uniform index.
        body += exports.CROCKFORD_ALPHABET[byte & 31];
    }
    return buildCode(kind, body);
}
function defaultRandomByte() {
    const bytes = new Uint8Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0];
}
/** Display form (with hyphen) for any valid encoded code; input returned as-is when invalid. */
function displayCode(input) {
    var _a, _b;
    return (_b = (_a = parseCode(input)) === null || _a === void 0 ? void 0 : _a.display) !== null && _b !== void 0 ? _b : input;
}
/** Encoded form (no hyphen) for QR codes. */
function encodeCode(input) {
    var _a, _b;
    return (_b = (_a = parseCode(input)) === null || _a === void 0 ? void 0 : _a.encoded) !== null && _b !== void 0 ? _b : normaliseCode(input);
}
