// Thin wrappers around stream-json.
//
// stream-json is CommonJS; under this package's ESM ("type": "module")
// Node does not statically see its named exports (each submodule attaches
// its factory as a property of module.exports rather than exporting it
// directly), so every submodule is imported as a default and destructured
// below. Confirmed empirically against the installed 1.9.1 package rather
// than assumed.
//
// numberAsString is used everywhere in this file: every price file this
// service reads (Cardmarket's price guide, TCGCSV's groups/products/prices,
// and PocketBase's own JSON responses) can contain decimal amounts as bare
// JSON numbers (Cardmarket and TCGCSV both do - see src/lib/cardmarket.mjs
// and src/lib/tcgcsv.mjs for confirmed samples). Parsing those the normal
// way would hand a float to code that must never see one (CLAUDE.md,
// "Money"), so every parse in this service goes through here, which keeps
// each number as the exact source string for src/lib/money.mjs to parse.
import streamJsonPkg from "stream-json";
import PickPkg from "stream-json/filters/Pick.js";
import StreamArrayPkg from "stream-json/streamers/StreamArray.js";
import StreamValuesPkg from "stream-json/streamers/StreamValues.js";

const { parser } = streamJsonPkg;
const { pick } = PickPkg;
const { streamArray } = StreamArrayPkg;
const { streamValues } = StreamValuesPkg;

/**
 * Parse an entire JSON document from a Node Readable, preserving every
 * number as its original decimal string. Used for every "small" JSON
 * response in this service (PocketBase records, TCGCSV groups/products/
 * prices) - never a plain `await response.json()`, so a stray float can
 * never reach money code.
 */
export function parseJsonStream(nodeReadable) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let value;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const pipeline = nodeReadable.pipe(parser()).pipe(streamValues({ numberAsString: true }));
    nodeReadable.on("error", fail);
    pipeline.on("error", fail);
    pipeline.on("data", (chunk) => {
      value = chunk.value;
    });
    pipeline.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(value);
    });
  });
}

/**
 * Stream a single top-level array field (e.g. Cardmarket's "priceGuides")
 * out of a large JSON document without ever buffering the whole thing.
 * Calls onEntry(value) once per array element, in order, keeping every
 * number as a decimal string exactly as parseJsonStream does.
 *
 * Returns a promise that resolves with the number of entries streamed.
 */
export function streamPickedArray(nodeReadable, fieldName, onEntry) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let count = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const pipeline = nodeReadable
      .pipe(parser())
      .pipe(pick({ filter: fieldName }))
      .pipe(streamArray({ numberAsString: true }));
    nodeReadable.on("error", fail);
    pipeline.on("error", fail);
    pipeline.on("data", ({ value }) => {
      count += 1;
      try {
        onEntry(value);
      } catch (err) {
        fail(err);
      }
    });
    pipeline.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(count);
    });
  });
}
