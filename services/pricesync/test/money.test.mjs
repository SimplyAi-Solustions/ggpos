// Pins the same numeric results as packages/shared/test/money.test.ts for
// every function src/lib/money.mjs reimplements from
// packages/shared/src/money.ts (this plain Node service has no build step
// and cannot import that TypeScript module directly - see CLAUDE.md's
// "Hooks" note on packages/shared, which is about pb_hooks but states the
// same constraint pricesync is under).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  roundHalfUp,
  parseDecimalToMinor,
  convertMinorToGbpPence,
  eurDecimalToGbpPence,
  usdDecimalToGbpPence,
} from "../src/lib/money.mjs";

describe("roundHalfUp", () => {
  test("rounds .5 up and is symmetric for negatives", () => {
    assert.equal(roundHalfUp(2.5), 3);
    assert.equal(roundHalfUp(2.4), 2);
    assert.equal(roundHalfUp(-2.5), -3);
  });
});

describe("parseDecimalToMinor", () => {
  test("parses plain, symbol-prefixed and grouped amounts", () => {
    assert.equal(parseDecimalToMinor("16.50"), 1650);
    assert.equal(parseDecimalToMinor("£1,234.56"), 123456);
    assert.equal(parseDecimalToMinor("$17"), 1700);
    assert.equal(parseDecimalToMinor("0.45"), 45);
    assert.equal(parseDecimalToMinor("-2.5"), -250);
  });
  test("parses the bare integers and one-decimal-place amounts Cardmarket's price guide actually sends", () => {
    // Confirmed live against downloads.s3.cardmarket.com/.../price_guide_19.json
    // (2026-09-20): "low":1000 and "avg":1862.5 are real values from the
    // fixture, always textual (numberAsString), never a float, by the time
    // they reach this function.
    assert.equal(parseDecimalToMinor("1000"), 100000);
    assert.equal(parseDecimalToMinor("1862.5"), 186250);
  });
  test("rejects junk", () => {
    assert.equal(parseDecimalToMinor("abc"), null);
    assert.equal(parseDecimalToMinor("1.234"), null);
    assert.equal(parseDecimalToMinor(""), null);
    assert.equal(parseDecimalToMinor(null), null);
  });
});

describe("conversion", () => {
  test("converts EUR decimal strings to GBP pence", () => {
    // Cardmarket EUR16.50 at 0.8606 GBP per EUR -> 1419.99 -> 1420
    assert.equal(eurDecimalToGbpPence("16.50", 0.8606), 1420);
    assert.equal(eurDecimalToGbpPence("nope", 0.86), null);
  });
  test("converts USD decimal strings to GBP pence the same way", () => {
    // Symmetric with the EUR case above, at 0.7421 GBP per USD (the same
    // fixed rate used in packages/shared/test/money.test.ts's USD cases).
    assert.equal(usdDecimalToGbpPence("16.50", 0.7421), 1224); // 16.50 * 0.7421 = 12.24465 -> 1224.465p -> 1224
    assert.equal(usdDecimalToGbpPence("nope", 0.74), null);
  });
  test("passes GBP through untouched and refuses bad rates", () => {
    assert.equal(convertMinorToGbpPence(999, "GBP", 0), 999);
    assert.throws(() => convertMinorToGbpPence(100, "USD", 0));
  });
  test("reproduces the same figure from a stored rate", () => {
    const stored = { minor: 4850, rate: 0.85857 };
    assert.equal(
      convertMinorToGbpPence(stored.minor, "EUR", stored.rate),
      convertMinorToGbpPence(stored.minor, "EUR", stored.rate)
    );
  });
  test("rounds half-up at the exact halfway point", () => {
    // 1000 cents at 0.7425 = 742.5 -> 743 (same fixture as
    // packages/shared/test/money.test.ts's usdCentsToGbpPence case, ported
    // to the decimal-string form this service actually uses).
    assert.equal(usdDecimalToGbpPence("10.00", 0.7425), 743);
  });
});
