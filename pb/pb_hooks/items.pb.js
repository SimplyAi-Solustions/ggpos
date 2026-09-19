/// <reference path="../pb_data/types.d.ts" />

/**
 * items.pb.js
 *
 * On create:
 *  - assign `sku` when left empty (single/graded/retro/sealed/accessory/
 *    other, from the item's `kind`), retrying the random body until one
 *    is confirmed unique;
 *  - derive `title` when left empty, from the linked card or retro title.
 *
 * Every require() happens inside the handler - each pb_hooks handler runs
 * in its own isolated goja context, so a module cached at file top level
 * would not reliably be visible when the handler actually fires.
 */
onRecordCreate((e) => {
  const sku = require(`${__hooks}/lib/shared/sku.js`);

  if (!e.record.getString("sku")) {
    e.record.set("sku", generateUniqueSku(e.app, sku, e.record.getString("kind")));
  }

  deriveTitleIfEmpty(e.app, e.record);

  e.next();
}, "items");

/**
 * Generate a SKU body and confirm it is not already taken before handing
 * it back, retrying with a fresh random body on a collision.
 *
 * This checks uniqueness itself with findFirstRecordByFilter rather than
 * setting a candidate and calling e.next() again on failure: verified
 * against PocketBase v0.40.4, a *second* e.next() call from the same
 * handler can report a successful create without a matching row actually
 * being persisted, so a handler must only ever call e.next() once. With
 * 32^5 (about 33.5 million) bodies per kind, a handful of attempts is
 * ample headroom before this ever has to give up.
 */
function generateUniqueSku(app, sku, kind) {
  const validKind = sku.CODE_KINDS[kind] ? kind : "other";
  const randomByte = () =>
    $security.randomStringWithAlphabet(1, sku.CROCKFORD_ALPHABET).charCodeAt(0);

  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = sku.generateCode(validKind, randomByte);
    try {
      app.findFirstRecordByFilter("items", "sku = {:sku}", { sku: code.encoded });
      // Found an existing row with this code - try again.
    } catch (err) {
      // Not found means the code is free to use.
      return code.encoded;
    }
  }
  throw new Error(`Could not generate a unique SKU after ${maxAttempts} attempts`);
}

/** Fill `title` from the linked card or retro title when left blank. */
function deriveTitleIfEmpty(app, record) {
  if (record.getString("title")) return;

  const cardId = record.getString("card");
  if (cardId) {
    try {
      const card = app.findRecordById("cards", cardId);
      const number = card.getString("number");
      record.set("title", number ? `${card.getString("name")} #${number}` : card.getString("name"));
      return;
    } catch (err) {
      // Linked card vanished or is inaccessible - fall through.
    }
  }

  const retroTitleId = record.getString("retro_title");
  if (retroTitleId) {
    try {
      const retroTitle = app.findRecordById("retro_titles", retroTitleId);
      record.set("title", retroTitle.getString("name"));
      return;
    } catch (err) {
      // Fall through.
    }
  }

  // Nothing to derive from (a manual "not in catalogue" entry) - leave
  // title blank; staff fill it in from the item page.
}
