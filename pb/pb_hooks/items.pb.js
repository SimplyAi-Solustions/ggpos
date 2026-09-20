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
   * $security.randomStringWithAlphabet draws each character uniformly from
   * the alphabet; generating the whole 5-character body from it in one
   * call and checking it with sku.buildCode avoids the bias in
   * sku.generateCode's default randomByte-and-mask-with-31 path (32 is a
   * clean power of two, but a single alphabet *character*'s code point is
   * not, so `charCode & 31` favours nine symbols and never produces the
   * other nine).
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

    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const body = $security.randomStringWithAlphabet(5, sku.CROCKFORD_ALPHABET);
      const code = sku.buildCode(validKind, body);
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

  // Phase 3 (docs/PLAN.md, "Card images and market prices"): the first time
  // an item is created against a card whose image is still a bare
  // third-party URL, queue it to be fetched and cached in PocketBase, so a
  // label or a receipt printed years later never depends on that host still
  // being up. Only after e.next() has actually committed the item.
  //
  // This only ever queues, never fetches: a buy-in creates every item
  // inside one $app.runInTransaction, so e.app here can be that
  // transaction's own txApp, and a network call at this point would hold
  // the whole transaction open for as long as the image host takes to
  // answer - a slow or unreachable host would then time out the buy-in
  // itself. The actual fetch happens later, off this path entirely, when
  // crons.pb.js's "image_queue" cron drains the queue. A card with no image,
  // or one already re-hosted (YGOPRODeck/OPTCG results are re-hosted
  // immediately at lookup time), costs nothing here either way.
  const cardId = e.record.getString("card");
  if (cardId) {
    try {
      const images = require(`${__hooks}/adapters/images.js`);
      images.enqueueImageCache(e.app, cardId);
    } catch (err) {
      console.log(`[items] could not queue the image cache for card ${cardId}: ${err}`);
    }
  }
}, "items");
