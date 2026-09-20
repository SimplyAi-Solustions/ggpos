// Malformed input on every parser path must reject cleanly (so a caller
// can log a warning and move on) rather than crash the process with an
// unhandled 'error' event - see the fix on json-stream.mjs (using
// node:stream/promises pipeline() rather than manual .pipe() chaining,
// which does not forward 'error' events between the streams it connects).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { parseJsonStream, streamPickedArray } from "../src/lib/json-stream.mjs";

describe("parseJsonStream", () => {
  test("rejects (does not crash the process) on a 502 HTML body", async () => {
    const html = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    await assert.rejects(() => parseJsonStream(Readable.from(html)));
  });

  test("rejects on a truncated file", async () => {
    const truncated = '{"version":1,"priceGuides":[{"idProduct":1,"avg":';
    await assert.rejects(() => parseJsonStream(Readable.from(truncated)));
  });

  test("rejects when the source stream itself errors", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    await assert.rejects(() => parseJsonStream(source), /connection reset/);
  });

  test("still parses valid JSON correctly (not broken by the malformed-input handling)", async () => {
    const value = await parseJsonStream(Readable.from('{"a":1,"b":"2.50"}'));
    assert.deepEqual(value, { a: "1", b: "2.50" });
  });
});

describe("streamPickedArray", () => {
  test("rejects on a 502 HTML body instead of silently streaming zero entries", async () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    await assert.rejects(() => streamPickedArray(Readable.from(html), "priceGuides", () => {}));
  });

  test("rejects on a truncated file", async () => {
    const truncated = '{"priceGuides":[{"idProduct":1,"avg":1.5},{"idProduct":2,"avg":';
    const seen = [];
    await assert.rejects(() => streamPickedArray(Readable.from(truncated), "priceGuides", (e) => seen.push(e)));
    // The one complete entry before the truncation point may or may not
    // have been delivered depending on exactly where the cut lands - the
    // important thing is the call rejects rather than silently returning
    // a partial "success".
  });

  test("propagates an onEntry callback's own exception as the pipeline's rejection", async () => {
    const json = '{"priceGuides":[{"idProduct":1},{"idProduct":2}]}';
    await assert.rejects(
      () =>
        streamPickedArray(Readable.from(json), "priceGuides", () => {
          throw new Error("boom from onEntry");
        }),
      /boom from onEntry/
    );
  });

  test("still streams a valid file's entries correctly (not broken by the malformed-input handling)", async () => {
    const json = '{"priceGuides":[{"idProduct":1,"avg":1.5},{"idProduct":2,"avg":2.5}]}';
    const seen = [];
    const count = await streamPickedArray(Readable.from(json), "priceGuides", (e) => seen.push(e));
    assert.equal(count, 2);
    assert.deepEqual(
      seen.map((e) => e.idProduct),
      ["1", "2"]
    );
  });
});
