/// <reference path="../pb_data/types.d.ts" />

/**
 * The seeded single bands were NM-only, so an LP, MP, HP or DMG single
 * matched no pricing rule at all and priced to nothing.
 *
 * Condition is already applied before a rule is chosen: the shared evaluator
 * runs adjustForCondition over the market value and only then calls
 * selectRule, so a condition on the band double-counted it and, worse, left
 * every non-NM card unmatched. The bands are now condition wildcards.
 *
 * 1789819620_seed.js writes them that way for a fresh install; this migration
 * is for the installs that already ran the old seed. It only touches
 * single-kind rows that still say "NM", so a shop that has since written its
 * own condition-specific rule keeps it.
 */
migrate((app) => {
  let rows = [];
  try {
    rows = app.findRecordsByFilter(
      "pricing_rules",
      'kind = "single" && condition = "NM"',
      "band_min",
      0,
      0
    );
  } catch (err) {
    rows = [];
  }
  for (const row of rows) {
    if (!row) continue;
    row.set("condition", "");
    app.save(row);
  }
}, (app) => {
  // Back to NM-only on the three seeded bands, matched by their band edges
  // so a hand-written wildcard rule is left alone.
  let rows = [];
  try {
    rows = app.findRecordsByFilter(
      "pricing_rules",
      'kind = "single" && condition = ""',
      "band_min",
      0,
      0
    );
  } catch (err) {
    rows = [];
  }
  for (const row of rows) {
    if (!row) continue;
    const min = row.getInt("band_min");
    if (min === 0 || min === 500 || min === 5000) {
      row.set("condition", "NM");
      app.save(row);
    }
  }
});
