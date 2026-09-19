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
 * Everything the handler needs - require()d modules and helper functions
 * alike - is defined *inside* the handler. Each registered handler runs
 * in its own isolated goja context, so a module or function only visible
 * at file top level is not reliably visible once the handler actually
 * fires (verified against v0.40.4 while building pb/pb_hooks/routes.pb.js
 * - see pb/README.md).
 */
onRecordCreate((e) => {
  const sku = require(`${__hooks}/lib/shared/sku.js`);

  /**
   * Generate a SKU body and confirm it is not already taken before
   * handing it back, retrying with a fresh random body on a collision.
   *
   * This checks uniqueness itself with findFirstRecordByFilter rather
   * than setting a candidate and calling e.next() again on failure:
   * verified against v0.40.4, a *second* e.next() call from the same
   * handler can report a successful create without a matching row
   * actually being persisted, so a handler must only ever call e.next()
   * once. With 32^5 (about 33.5 million) bodies per kind, a handful of
   * attempts is ample headroom before this ever has to give up.
   */
  function generateUniqueSku(kind) {
    const validKind = sku.CODE_KINDS[kind] ? kind : "other";
    const randomByte = () =>
      $security.randomStringWithAlphabet(1, sku.CROCKFORD_ALPHABET).charCodeAt(0);

    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = sku.generateCode(validKind, randomByte);
      try {
        e.app.findFirstRecordByFilter("items", "sku = {:sku}", { sku: code.encoded });
        // Found an existing row with this code - loop and try again.
      } catch (err) {
        // Not found means the code is free to use.
        return code.encoded;
      }
    }
    throw new Error(`Could not generate a unique SKU after ${maxAttempts} attempts`);
  }

  /** Fill `title` from the linked card or retro title when left blank. */
  function deriveTitleIfEmpty() {
    if (e.record.getString("title")) return;

    const cardId = e.record.getString("card");
    if (cardId) {
      try {
        const card = e.app.findRecordById("cards", cardId);
        const number = card.getString("number");
        e.record.set(
          "title",
          number ? `${card.getString("name")} #${number}` : card.getString("name")
        );
        return;
      } catch (err) {
        // Linked card vanished or is inaccessible - fall through.
      }
    }

    const retroTitleId = e.record.getString("retro_title");
    if (retroTitleId) {
      try {
        const retroTitle = e.app.findRecordById("retro_titles", retroTitleId);
        e.record.set("title", retroTitle.getString("name"));
        return;
      } catch (err) {
        // Fall through.
      }
    }

    // Nothing to derive from (a manual "not in catalogue" entry) - leave
    // title blank; staff fill it in from the item page.
  }

  if (!e.record.getString("sku")) {
    e.record.set("sku", generateUniqueSku(e.record.getString("kind")));
  }

  deriveTitleIfEmpty();

  e.next();
}, "items");
