/// <reference path="../pb_data/types.d.ts" />

/**
 * Loyalty collections (GG Guild). See docs/PLAN.md, "Data model
 * (PocketBase collections) > Loyalty (GG Guild)".
 *
 * "API rules in short" names "loyalty_*" as admin-only; that is applied
 * literally here to every collection whose name starts with loyalty_
 * (loyalty_programme, loyalty_rules, loyalty_tiers, loyalty_rewards) for
 * every rule, including list/view. That also blocks the portal's own
 * tier badge and rewards catalogue reads for now - see pb/README.md for
 * the follow-up (a read-only custom route once the portal is built)
 * rather than loosening this rule ahead of that need.
 *
 * memberships, reward_redemptions, points_ledger, perk_usage and
 * referrals do not match the loyalty_* prefix and are handled per
 * PLAN.md's other rule buckets (reward_redemptions and points_ledger are
 * customer-readable; the rest default to staff-only).
 */
migrate((app) => {
  const STAFF_ONLY = '@request.auth.collectionName = "staff"';
  const ADMIN_ONLY = '@request.auth.collectionName = "staff" && @request.auth.role = "admin"';
  // Any signed-in staff member or customer: the portal shows the programme, tiers and rewards.
  const SIGNED_IN = '@request.auth.id != ""';
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const customers = app.findCollectionByNameOrId("customers");
  const staff = app.findCollectionByNameOrId("staff");
  const sales = app.findCollectionByNameOrId("sales");

  // ---------------------------------------------------------------------
  // loyalty_programme: single record, admin-editable. Singleton enforced
  // by pb_hooks/singletons.pb.js.
  // ---------------------------------------------------------------------
  const loyaltyProgramme = new Collection({
    name: "loyalty_programme",
    type: "base",
    listRule: SIGNED_IN,
    viewRule: SIGNED_IN,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "enabled", type: "bool" },
      { name: "name", type: "text", max: 100 },
      { name: "points_name", type: "text", max: 100 },
      { name: "earn_per_pound_sales", type: "number", onlyInt: true, min: 0 },
      { name: "earn_on_trade_in_credit", type: "number", onlyInt: true, min: 0 },
      { name: "points_per_pound_redemption", type: "number", onlyInt: true, min: 0 },
      { name: "min_redeem_points", type: "number", onlyInt: true, min: 0 },
      { name: "max_points_share_of_sale", type: "number", min: 0, max: 100 }, // percent
      { name: "expiry_months_inactive", type: "number", onlyInt: true, min: 0 },
      { name: "tier_window_months", type: "number", onlyInt: true, min: 0 },
      { name: "welcome_bonus", type: "number", onlyInt: true, min: 0 },
      { name: "referral_bonus_referrer", type: "number", onlyInt: true, min: 0 },
      { name: "referral_bonus_referee", type: "number", onlyInt: true, min: 0 },
      { name: "terms", type: "editor" },
      ...autodates(),
    ],
  });
  app.save(loyaltyProgramme);

  // ---------------------------------------------------------------------
  // loyalty_rules: ordered, stackable rule set (packages/shared houses the
  // pure evaluator that reads these).
  // ---------------------------------------------------------------------
  const loyaltyRules = new Collection({
    name: "loyalty_rules",
    type: "base",
    listRule: ADMIN_ONLY,
    viewRule: ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "name", type: "text", required: true, max: 200 },
      {
        name: "type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: [
          "multiplier",
          "fixed_bonus",
          "first_purchase",
          "birthday_month",
          "trade_in_credit_bonus",
          "event_checkin",
          "day_of_week",
        ],
      },
      { name: "conditions", type: "json", maxSize: 20000 },
      { name: "value", type: "number" }, // multiplier or bonus amount, decimals allowed
      { name: "active", type: "bool" },
      { name: "priority", type: "number", onlyInt: true },
      { name: "starts_at", type: "date" },
      { name: "ends_at", type: "date" },
      ...autodates(),
    ],
  });
  app.save(loyaltyRules);

  // ---------------------------------------------------------------------
  // loyalty_tiers: Member / Regular / Legend by default (seeded later).
  // ---------------------------------------------------------------------
  const loyaltyTiers = new Collection({
    name: "loyalty_tiers",
    type: "base",
    listRule: SIGNED_IN,
    viewRule: SIGNED_IN,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "name", type: "text", required: true, max: 100 },
      // Not required: the Member tier's threshold is legitimately 0, and
      // PocketBase's required check on a number field treats 0 as blank.
      { name: "threshold_points", type: "number", onlyInt: true, min: 0 },
      { name: "colour_token", type: "text", max: 60 },
      { name: "sort", type: "number", onlyInt: true },
      { name: "perks", type: "json", maxSize: 20000 },
      { name: "paid_plan", type: "bool" },
      ...autodates(),
    ],
  });
  app.save(loyaltyTiers);

  // Complete the customer_private <-> loyalty_tiers relation started in
  // 1789819200_auth_collections.js.
  const customerPrivate = app.findCollectionByNameOrId("customer_private");
  customerPrivate.fields.add(
    new Field({ name: "tier", type: "relation", collectionId: loyaltyTiers.id, maxSelect: 1 })
  );
  app.save(customerPrivate);

  // ---------------------------------------------------------------------
  // memberships: paid Guild Pass style plans that pin a tier.
  // ---------------------------------------------------------------------
  const memberships = new Collection({
    name: "memberships",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "tier", type: "relation", required: true, collectionId: loyaltyTiers.id, maxSelect: 1 },
      { name: "status", type: "select", maxSelect: 1, values: ["active", "lapsed", "cancelled"] },
      { name: "started_at", type: "date" },
      { name: "renews_at", type: "date" },
      { name: "price", type: "number", onlyInt: true, min: 0 },
      { name: "payment_note", type: "text", max: 500 },
      ...autodates(),
    ],
  });
  app.save(memberships);

  // ---------------------------------------------------------------------
  // loyalty_rewards: catalogue of redeemable rewards.
  // ---------------------------------------------------------------------
  const loyaltyRewards = new Collection({
    name: "loyalty_rewards",
    type: "base",
    listRule: SIGNED_IN,
    viewRule: SIGNED_IN,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
    fields: [
      { name: "name", type: "text", required: true, max: 200 },
      { name: "description", type: "editor" },
      // Not required - see loyalty_tiers.threshold_points for why (a free
      // promotional reward could legitimately cost 0 points).
      { name: "cost_points", type: "number", onlyInt: true, min: 0 },
      {
        name: "type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["money_off", "store_credit", "free_item", "event_entry", "custom"],
      },
      { name: "value", type: "number", onlyInt: true, min: 0 },
      { name: "stock_limit", type: "number", onlyInt: true, min: 0 },
      { name: "per_customer_limit", type: "number", onlyInt: true, min: 0 },
      { name: "active", type: "bool" },
      { name: "starts_at", type: "date" },
      { name: "ends_at", type: "date" },
      { name: "image", type: "file", maxSelect: 1, maxSize: 5242880 },
      ...autodates(),
    ],
  });
  app.save(loyaltyRewards);

  // ---------------------------------------------------------------------
  // reward_redemptions: customer-readable (own). number is the sequential
  // GG-V-000012 form (lib/counters.js); code is the short scannable GGV-…
  // voucher (lib/codes.js / redemptions.pb.js).
  // ---------------------------------------------------------------------
  const rewardRedemptions = new Collection({
    name: "reward_redemptions",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "number", type: "text", required: true, max: 20 },
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "reward", type: "relation", required: true, collectionId: loyaltyRewards.id, maxSelect: 1 },
      { name: "points_spent", type: "number", onlyInt: true, min: 0 },
      { name: "code", type: "text", max: 20 },
      { name: "status", type: "select", maxSelect: 1, values: ["issued", "used", "expired", "cancelled"] },
      { name: "used_in_sale", type: "relation", collectionId: sales.id, maxSelect: 1 },
      { name: "used_by", type: "relation", collectionId: staff.id, maxSelect: 1 },
      { name: "expires_at", type: "date" },
      ...autodates(),
    ],
  });
  rewardRedemptions.addIndex("idx_reward_redemptions_number_unique", true, "number", "");
  rewardRedemptions.addIndex("idx_reward_redemptions_code_unique", true, "code", "");
  app.save(rewardRedemptions);

  // ---------------------------------------------------------------------
  // points_ledger: append-only (per PLAN.md), customer-readable (own).
  // ---------------------------------------------------------------------
  const pointsLedger = new Collection({
    name: "points_ledger",
    type: "base",
    listRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    viewRule: `${STAFF_ONLY} || customer = @request.auth.id`,
    createRule: STAFF_ONLY,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      // Not required - see credit_ledger.amount for why (0 is a valid
      // signed value that PocketBase's required check would reject).
      { name: "delta", type: "number", onlyInt: true },
      {
        name: "reason",
        type: "select",
        required: true,
        maxSelect: 1,
        values: [
          "earn_sale",
          "earn_trade_in",
          "rule_bonus",
          "welcome",
          "referral",
          "redeem",
          "adjust",
          "expire",
          "refund_reverse",
        ],
      },
      { name: "ref", type: "text", max: 100 },
      { name: "rule", type: "relation", collectionId: loyaltyRules.id, maxSelect: 1 },
      { name: "balance_after", type: "number", onlyInt: true },
      { name: "staff", type: "relation", collectionId: staff.id, maxSelect: 1 },
      ...autodates(),
    ],
  });
  app.save(pointsLedger);

  // ---------------------------------------------------------------------
  // perk_usage: monthly perk counters (two free event entries a month,
  // etc). Not in PLAN.md's customer-readable list, so staff-only for now
  // - see pb/README.md follow-up.
  // ---------------------------------------------------------------------
  const perkUsage = new Collection({
    name: "perk_usage",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "customer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "perk_type", type: "text", required: true, max: 100 },
      { name: "period", type: "text", required: true, max: 10 }, // "2026-09"
      { name: "used_count", type: "number", onlyInt: true, min: 0 },
      ...autodates(),
    ],
  });
  perkUsage.addIndex("idx_perk_usage_lookup", true, "customer, perk_type, period", "");
  app.save(perkUsage);

  // ---------------------------------------------------------------------
  // referrals: bookkeeping only - the customer-facing referral code is
  // simply the referrer's own customers.code, so this stays staff-only.
  // ---------------------------------------------------------------------
  const referrals = new Collection({
    name: "referrals",
    type: "base",
    listRule: STAFF_ONLY,
    viewRule: STAFF_ONLY,
    createRule: STAFF_ONLY,
    updateRule: STAFF_ONLY,
    deleteRule: STAFF_ONLY,
    fields: [
      { name: "referrer", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "referee", type: "relation", required: true, collectionId: customers.id, maxSelect: 1 },
      { name: "status", type: "select", maxSelect: 1, values: ["pending", "earned"] },
      { name: "earned_at", type: "date" },
      ...autodates(),
    ],
  });
  app.save(referrals);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("referrals"));
  app.delete(app.findCollectionByNameOrId("perk_usage"));
  app.delete(app.findCollectionByNameOrId("points_ledger"));
  app.delete(app.findCollectionByNameOrId("reward_redemptions"));
  app.delete(app.findCollectionByNameOrId("loyalty_rewards"));
  app.delete(app.findCollectionByNameOrId("memberships"));

  const customerPrivate = app.findCollectionByNameOrId("customer_private");
  customerPrivate.fields.removeByName("tier");
  app.save(customerPrivate);

  app.delete(app.findCollectionByNameOrId("loyalty_tiers"));
  app.delete(app.findCollectionByNameOrId("loyalty_rules"));
  app.delete(app.findCollectionByNameOrId("loyalty_programme"));
});
