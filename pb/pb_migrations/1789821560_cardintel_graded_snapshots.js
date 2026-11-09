/// <reference path="../pb_data/types.d.ts" />

/**
 * Card price intelligence for the vault (apps/vault/src/features/cards and
 * features/scan; pb_hooks/vault_snapshots.pb.js). Additive only.
 *
 * `price_snapshots` gains three text columns, every existing row keeping
 * the empty string, which is what every existing read matches:
 *  - grader, grade   a graded slab's price ("PSA" "10", "ACE" "10"). Blank
 *                    is a raw card. adapters/pricing_policy.js's snapshotsFor
 *                    only ever reads blank rows, so a graded figure can never
 *                    become the raw NM market.
 *  - basis           "" for a spot price; "avg1", "avg7" or "avg30" for a
 *                    Cardmarket rolling average written once as a dated
 *                    trend point (vault_snapshots.pb.js seeds them so a chart
 *                    has a real recent trend from day one). Never read by
 *                    the valuation routes either.
 *
 * `research_requests` gains `grader` and `grade`, so a request can ask for
 * graded UK sold comps ("PSA 10" of this card), which the completion writes
 * as graded snapshots.
 *
 * `card_scans` is new: one row each time a card is read from a photo, found
 * from a search, or opened, so the daily snapshot job knows which cards
 * staff have handled in the last 30 days. Written by routes only.
 *
 * `settings.grading` holds the grading fee config the "Worth grading?" panel
 * reads, in pence, with UK starting figures the shop checks against the
 * graders' current price lists (the panel says "check current fees").
 */
migrate(
  (app) => {
    const STAFF_ONLY = '@request.auth.collectionName = "staff"';

    const snapshots = app.findCollectionByNameOrId("price_snapshots");
    snapshots.fields.add(new Field({ name: "grader", type: "text", max: 20 }));
    snapshots.fields.add(new Field({ name: "grade", type: "text", max: 20 }));
    snapshots.fields.add(new Field({ name: "basis", type: "text", max: 20 }));
    snapshots.addIndex("idx_price_snapshots_graded", false, "card, grader, grade, fetched_at", "");
    app.save(snapshots);

    const research = app.findCollectionByNameOrId("research_requests");
    research.fields.add(new Field({ name: "grader", type: "text", max: 20 }));
    research.fields.add(new Field({ name: "grade", type: "text", max: 20 }));
    app.save(research);

    const cards = app.findCollectionByNameOrId("cards");
    const staff = app.findCollectionByNameOrId("staff");
    const scans = new Collection({
      type: "base",
      name: "card_scans",
      listRule: STAFF_ONLY,
      viewRule: STAFF_ONLY,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "card", type: "relation", required: true, collectionId: cards.id, maxSelect: 1, cascadeDelete: true },
        { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1, cascadeDelete: false },
        { name: "kind", type: "select", required: true, maxSelect: 1, values: ["photo", "search", "view"] },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: [
        "CREATE INDEX idx_card_scans_card ON card_scans (card, created)",
        "CREATE INDEX idx_card_scans_created ON card_scans (created)",
      ],
    });
    app.save(scans);

    const settings = app.findCollectionByNameOrId("settings");
    if (!settings.fields.getByName("grading")) {
      settings.fields.add(new Field({ name: "grading", type: "json", maxSize: 5000 }));
      app.save(settings);
    }
    let row = null;
    try {
      row = app.findFirstRecordByFilter("settings", "id != ''");
    } catch (err) {
      row = null;
    }
    if (row) {
      let grading = null;
      try {
        const raw = row.get("grading");
        grading = raw ? JSON.parse(toString(raw)) : null;
      } catch (err) {
        grading = null;
      }
      if (!grading || typeof grading !== "object") {
        row.set("grading", {
          // Pence. Starting points, not quotes: the shop checks these against
          // ACE Grading's and PSA's current UK price lists.
          ace_standard_pence: 1500,
          psa_value_pence: 2500,
          // Tracked post there and back, per card, when sent on its own.
          postage_pence: 800,
          // Under this profit at a 10 the verdict is Marginal, not Worth grading.
          min_profit_pence: 1000,
          fees_checked_on: "",
        });
        app.save(row);
      }
    }
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("card_scans"));
    } catch (err) {
      // Already gone.
    }
    const research = app.findCollectionByNameOrId("research_requests");
    research.fields.removeByName("grade");
    research.fields.removeByName("grader");
    app.save(research);

    const snapshots = app.findCollectionByNameOrId("price_snapshots");
    snapshots.removeIndex("idx_price_snapshots_graded");
    snapshots.fields.removeByName("basis");
    snapshots.fields.removeByName("grade");
    snapshots.fields.removeByName("grader");
    app.save(snapshots);

    const settings = app.findCollectionByNameOrId("settings");
    if (settings.fields.getByName("grading")) {
      settings.fields.removeByName("grading");
      app.save(settings);
    }
  }
);
