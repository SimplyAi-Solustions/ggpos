/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 4 follow-up: POST /api/vault/imports/:id/link (imports.pb.js,
 * lib/imports.js), so the counter screen's Card Uploader review queue can
 * resolve a "needs match" row through the same three-path matching rule
 * the automatic import uses, instead of creating an `items` row itself
 * through the collection API and bypassing it.
 *
 * Added to `csv_imports`:
 *  - `resolved_rows` (json): every row number this import has already
 *    linked or skipped, so a second attempt at the same row reads as 409
 *    rather than 404 once its `errors` entry has been dropped. Small by
 *    construction - it only grows one entry at a time, from a staff
 *    member's own clicks, never from the import itself.
 *  - `rows_skipped` (number): how many review rows have been dismissed
 *    with `{ skip: true }` rather than linked - a sensible place for the
 *    count to live, alongside `rows_total` and `rows_ok`.
 */
migrate(
  (app) => {
    const csvImports = app.findCollectionByNameOrId("csv_imports");
    csvImports.fields.add(new Field({ name: "resolved_rows", type: "json", maxSize: 20000 }));
    csvImports.fields.add(new Field({ name: "rows_skipped", type: "number", onlyInt: true, min: 0 }));
    app.save(csvImports);
  },
  (app) => {
    const csvImports = app.findCollectionByNameOrId("csv_imports");
    csvImports.fields.removeByName("rows_skipped");
    csvImports.fields.removeByName("resolved_rows");
    app.save(csvImports);
  }
);
