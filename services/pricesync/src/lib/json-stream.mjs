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
//
// Both functions below build their pipeline with node:stream/promises'
// pipeline() rather than manual .pipe() chaining. This matters for more
// than tidiness: .pipe() does not forward 'error' events between the
// streams it connects, so a syntax error from parser() or pick() - a 502
// HTML body, a truncated file, a proxy hiccup mid-response - would be an
// unhandled 'error' event on a stream nothing is listening to, which is
// fatal to the whole process. pipeline() attaches an error listener to
// every stage, forwards the first failure as a single rejection, and
// destroys every stream in the chain either way.
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
 *
 * Rejects (rather than crashing the process) on malformed or non-JSON
 * bytes at any stage - see the module doc above.
 */
export async function parseJsonStream(nodeReadable) {
  let value;
  const sink = new Writable({
    objectMode: true,
    write(chunk, _encoding, callback) {
      value = chunk.value;
      callback();
    },
  });
  await pipeline(nodeReadable, parser(), streamValues({ numberAsString: true }), sink);
  return value;
}

/**
 * Stream a single top-level array field (e.g. Cardmarket's "priceGuides")
 * out of a large JSON document without ever buffering the whole thing.
 * Calls onEntry(value) once per array element, in order, keeping every
 * number as a decimal string exactly as parseJsonStream does.
 *
 * Returns a promise that resolves with the number of entries streamed, or
 * rejects (never crashes the process - see the module doc above) on
 * malformed or non-JSON bytes at any stage.
 */
export async function streamPickedArray(nodeReadable, fieldName, onEntry) {
  let count = 0;
  const sink = new Writable({
    objectMode: true,
    write(chunk, _encoding, callback) {
      count += 1;
      try {
        onEntry(chunk.value);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
  await pipeline(nodeReadable, parser(), pick({ filter: fieldName }), streamArray({ numberAsString: true }), sink);
  return count;
}
