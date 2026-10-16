import { test } from "node:test";
import assert from "node:assert/strict";

import { run, HardFailure } from "../src/index.mjs";

test("pricesync module loads and exports run() and HardFailure", async () => {
  assert.equal(typeof run, "function");
  assert.equal(typeof HardFailure, "function");
});

test("run() fails fast with a clear message when required env vars are missing", async () => {
  await assert.rejects(() => run({}), (err) => {
    assert.ok(err instanceof HardFailure);
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /PB_URL/);
    return true;
  });
});
