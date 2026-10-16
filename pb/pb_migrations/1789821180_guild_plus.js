/// <reference path="../pb_data/types.d.ts" />

/**
 * The Guild's paid upgrade (docs/api-contract-launch.md, section 2): "GO
 * seeds a paid-plan tier "Guild+" if none exists, switches the product on,
 * and puts its price in Settings, Guild."
 *
 * - A paid-plan tier "Guild+" when the shop has no paid-plan tier at all.
 *   It sits between Regular and Legend in the ladder (`sort` 25), so a
 *   member who pays gets it unless their points already reach Legend
 *   (`resolveTier` gives whichever is higher). Its perks are a starting
 *   point the shop reshapes in Loyalty: 5% off sealed, points at 1.25
 *   times, two free event entries a month, members' event prices and early
 *   booking for releases.
 * - The Guild Membership till product granting that tier (or the shop's
 *   existing paid plan), switched on. Its price stays what it is (the seed's
 *   £24.00 a year) and is edited in Settings, Guild.
 *
 * `down()` switches the product off again and removes a "Guild+" tier this
 * migration made, unless a customer or a membership is on it.
 */

migrate(
  (app) => {
    let paid = null;
    try {
      paid = app.findFirstRecordByFilter("loyalty_tiers", "paid_plan = true");
    } catch (err) {
      paid = null;
    }

    if (!paid) {
      const tiers = app.findCollectionByNameOrId("loyalty_tiers");
      paid = new Record(tiers);
      paid.set("name", "Guild+");
      paid.set("threshold_points", 0);
      paid.set("colour_token", "tier-plus");
      paid.set("sort", 25);
      paid.set("paid_plan", true);
      paid.set("perks", [
        { type: "percent_off", value: 5, scope: ["sealed"] },
        { type: "points_multiplier", value: 1.25 },
        { type: "free_event_entries", value: 2, perMonth: true },
        { type: "member_event_pricing" },
        { type: "priority_release_booking" },
      ]);
      app.save(paid);
    }

    app.findRecordsByFilter("till_products", "kind = 'membership'", "sort", 0, 0).forEach((product) => {
      if (!product.getString("membership_tier")) product.set("membership_tier", paid.id);
      if (product.getInt("membership_months") < 1) product.set("membership_months", 12);
      product.set("active", true);
      app.save(product);
    });
  },
  (app) => {
    app.findRecordsByFilter("till_products", "kind = 'membership'", "", 0, 0).forEach((product) => {
      product.set("active", false);
      app.save(product);
    });

    let plus = null;
    try {
      plus = app.findFirstRecordByFilter("loyalty_tiers", "name = 'Guild+' && paid_plan = true");
    } catch (err) {
      plus = null;
    }
    if (!plus) return;
    const held =
      app.findRecordsByFilter("customer_private", "tier = {:tier}", "", 1, 0, { tier: plus.id }).length > 0 ||
      app.findRecordsByFilter("memberships", "tier = {:tier}", "", 1, 0, { tier: plus.id }).length > 0;
    if (held) return;
    app.findRecordsByFilter("till_products", "membership_tier = {:tier}", "", 0, 0, { tier: plus.id }).forEach(
      (product) => {
        product.set("membership_tier", "");
        app.save(product);
      }
    );
    app.delete(plus);
  }
);
