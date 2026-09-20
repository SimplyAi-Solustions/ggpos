/// <reference path="../pb_data/types.d.ts" />

/**
 * Seed data: catalogue lookups, label templates, default pricing rules,
 * the loyalty programme and its starter tiers, the settings singleton,
 * the three sequence counters, and (only when GG_ADMIN_EMAIL and
 * GG_ADMIN_PASSWORD are set) the first admin staff account.
 *
 * See docs/PLAN.md's data model and "Product imagery" section for where
 * each seed value comes from.
 */
migrate((app) => {
  // -----------------------------------------------------------------
  // games
  // -----------------------------------------------------------------
  const games = [
    { key: "pokemon", name: "Pokemon" },
    { key: "mtg", name: "Magic: The Gathering" },
    { key: "yugioh", name: "Yu-Gi-Oh!" },
    { key: "onepiece", name: "One Piece" },
    { key: "lorcana", name: "Disney Lorcana" },
    { key: "retro", name: "Retro games and consoles" },
  ];
  const gamesCollection = app.findCollectionByNameOrId("games");
  for (const g of games) {
    app.save(new Record(gamesCollection, { key: g.key, name: g.name, enabled: true }));
  }

  // -----------------------------------------------------------------
  // platforms: drives the ProductImage aspect ratio and finish for
  // everything that is not a TCG card. Ratios and finishes as specified.
  // -----------------------------------------------------------------
  const platforms = [
    ["tcg_card", "TCG card", 63, 88, "shadow"],
    ["graded_slab", "Graded slab", 82, 135, "shadow"],
    ["gameboy_cart", "Game Boy cartridge", 57, 65, "edge"],
    ["snes_pal_box", "SNES PAL box", 190, 135, "edge"],
    ["n64_box", "N64 box", 195, 135, "edge"],
    ["megadrive_box", "Mega Drive box", 130, 180, "edge"],
    ["ps1_case", "PlayStation jewel case", 142, 125, "edge"],
    ["ps2_case", "PS2 / Xbox DVD case", 135, 190, "edge"],
    ["gamecube_case", "GameCube case", 135, 190, "edge"],
    ["switch_case", "Switch case", 105, 170, "edge"],
    ["gameboy_box", "Game Boy box", 90, 130, "edge"],
    ["etb", "Elite Trainer Box", 100, 115, "edge"],
    ["booster_box", "Booster box", 4, 3, "edge"],
    ["booster_pack", "Booster pack", 63, 105, "shadow"],
    ["console", "Console", 4, 3, "edge"],
    ["other", "Other / fallback", 3, 4, "edge"],
  ];
  const platformsCollection = app.findCollectionByNameOrId("platforms");
  platforms.forEach((p, i) => {
    app.save(
      new Record(platformsCollection, {
        key: p[0],
        name: p[1],
        aspect_w: p[2],
        aspect_h: p[3],
        image_finish: p[4],
        sort: (i + 1) * 10,
      })
    );
  });

  // -----------------------------------------------------------------
  // locations
  // -----------------------------------------------------------------
  const locations = [
    ["Showcase", "display"],
    ["Binder A", "binder"],
    ["Binder B", "binder"],
    ["Bin 1", "bin"],
    ["Storeroom", "storeroom"],
  ];
  const locationsCollection = app.findCollectionByNameOrId("locations");
  locations.forEach((l, i) => {
    app.save(new Record(locationsCollection, { name: l[0], type: l[1], sort: (i + 1) * 10 }));
  });

  // -----------------------------------------------------------------
  // label_templates (ORGSTA T003, 203 dpi)
  // -----------------------------------------------------------------
  const labelTemplatesCollection = app.findCollectionByNameOrId("label_templates");
  const labelTemplates = [
    ["toploader_40x20", "Top loader / unboxed retro", 40, 20],
    ["sleeve_25x15", "Sleeve / small accessory", 25, 15],
    ["retro_50x30", "Boxed retro", 50, 30],
    ["customer_card_80x50", "Customer QR card", 80, 50],
  ];
  const savedLabelTemplates = {};
  for (const t of labelTemplates) {
    const record = new Record(labelTemplatesCollection, {
      key: t[0],
      name: t[1],
      width_mm: t[2],
      height_mm: t[3],
      dpi: 203,
      active: true,
    });
    app.save(record);
    savedLabelTemplates[t[0]] = record;
  }

  // -----------------------------------------------------------------
  // pricing_rules: banded single rates plus flat retro and sealed rates.
  // game and condition are left empty (wildcard) throughout - kind (plus
  // band, for singles) is specific enough on its own; see pb/README.md.
  //
  // condition is deliberately a wildcard on the single bands. The shared
  // evaluator applies adjustForCondition to the market value *before* it
  // picks a rule, so an LP or MP card is already discounted by the time
  // selectRule runs; a condition-specific band would then leave every
  // non-NM single matching no rule at all and offering nothing.
  //
  // Bands chain on the exclusive-upper convention selectRule uses (band_min
  // inclusive, band_max exclusive): 0-500, 500-5000, 5000-open, so every
  // adjusted penny value lands in exactly one band, including the boundary
  // values 500 and 5000 themselves. band_max null (the open top band) is
  // requested as null here but PocketBase's plain "number" field has no
  // null state and always round-trips an unset value as 0 - see
  // pb/README.md and PricingRule.bandMax in packages/shared/src/pricing.ts,
  // whose selectRule treats 0 the same as null for exactly this reason.
  // -----------------------------------------------------------------
  const pricingRulesCollection = app.findCollectionByNameOrId("pricing_rules");
  const pricingRules = [
    // kind, condition, band_min, band_max, cash_pct, credit_pct, rounding, priority
    ["single", "", 0, 500, 40, 55, 25, 10], // under £5
    ["single", "", 500, 5000, 50, 65, 50, 20], // £5 to £50
    ["single", "", 5000, null, 60, 75, 50, 30], // £50 and over
    // Retro: loose, boxed and cib all take the same flat rate, so one
    // wildcard-condition row covers all three completeness values.
    ["retro", "", 0, null, 45, 60, 50, 40],
    ["sealed", "", 0, null, 55, 70, 50, 50],
  ];
  for (const r of pricingRules) {
    app.save(
      new Record(pricingRulesCollection, {
        kind: r[0],
        condition: r[1],
        band_min: r[2],
        band_max: r[3],
        cash_pct: r[4],
        credit_pct: r[5],
        rounding: r[6],
        priority: r[7],
        active: true,
      })
    );
  }

  // -----------------------------------------------------------------
  // loyalty_programme (single record; singletons.pb.js enforces this)
  // -----------------------------------------------------------------
  const loyaltyProgrammeCollection = app.findCollectionByNameOrId("loyalty_programme");
  app.save(
    new Record(loyaltyProgrammeCollection, {
      enabled: true,
      name: "GG Guild",
      points_name: "GG Points",
      earn_per_pound_sales: 10,
      earn_on_trade_in_credit: 5,
      points_per_pound_redemption: 100,
      min_redeem_points: 500,
      max_points_share_of_sale: 50,
      expiry_months_inactive: 18,
      tier_window_months: 12,
      welcome_bonus: 100,
      referral_bonus_referrer: 250,
      referral_bonus_referee: 250,
    })
  );

  // -----------------------------------------------------------------
  // loyalty_tiers: Member / Regular / Legend with example perks. These
  // are illustrative starting points - Richard reshapes them in the
  // admin editor without a migration.
  // -----------------------------------------------------------------
  const loyaltyTiersCollection = app.findCollectionByNameOrId("loyalty_tiers");
  const tiers = [
    {
      name: "Member",
      threshold_points: 0,
      colour_token: "tier-member",
      sort: 10,
      perks: [],
    },
    {
      name: "Regular",
      threshold_points: 2500,
      colour_token: "tier-regular",
      sort: 20,
      perks: [
        { type: "percent_off", value: 5, scope: ["sealed"] },
        { type: "points_multiplier", value: 1.25 },
      ],
    },
    {
      name: "Legend",
      threshold_points: 10000,
      colour_token: "tier-legend",
      sort: 30,
      perks: [
        {
          type: "percent_off",
          value: 10,
          scope: ["single", "graded", "retro", "sealed", "accessory", "other"],
        },
        { type: "points_multiplier", value: 1.5 },
        { type: "free_event_entries", value: 2, perMonth: true },
        { type: "lounge_hours", value: 12, perMonth: true },
        { type: "priority_release_booking" },
      ],
    },
  ];
  for (const t of tiers) {
    app.save(
      new Record(loyaltyTiersCollection, {
        name: t.name,
        threshold_points: t.threshold_points,
        colour_token: t.colour_token,
        sort: t.sort,
        perks: t.perks,
        paid_plan: false,
      })
    );
  }

  // -----------------------------------------------------------------
  // settings (single record; singletons.pb.js enforces this)
  // -----------------------------------------------------------------
  const settingsCollection = app.findCollectionByNameOrId("settings");
  app.save(
    new Record(settingsCollection, {
      cash_cap: 800000,
      // Not given a concrete figure anywhere in the brief - left at 0
      // (no floor / no bulk discount) pending a business decision; see
      // pb/README.md.
      min_single_offer: 0,
      bulk_rate_pct: 0,
      source_priority: ["uk_sold_manual", "ebay_uk_asking", "cardmarket", "tcgplayer"],
      retro_source_priority: [
        "uk_sold_manual",
        "pricecharting_pal",
        "ebay_uk_asking",
        "pricecharting_ntsc",
      ],
      // Matches ConditionMultipliers (packages/shared/src/pricing.ts): every
      // CardCondition key, including NM at 1 (no adjustment).
      condition_multipliers: { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 },
      // Matches MarkupBand[] (packages/shared/src/pricing.ts): { from, multiplier }.
      markup_bands: [
        { from: 0, multiplier: 1.1 },
        { from: 500, multiplier: 1.05 },
        { from: 5000, multiplier: 1.0 },
      ],
      sell_rounding: "49_99",
      label_default_template: savedLabelTemplates["toploader_40x20"].id,
      quote_expiry_days: 7,
      id_photo_retention_months: 12,
      vat_registered: false,
      shop_name: "GG Entertainment",
      shop_town: "Bolsover",
      email_provider: "none",
      api_keys: {},
    })
  );

  // -----------------------------------------------------------------
  // counters
  // -----------------------------------------------------------------
  const countersCollection = app.findCollectionByNameOrId("counters");
  for (const key of ["trade_in", "sale", "redemption"]) {
    app.save(new Record(countersCollection, { key: key, value: 0 }));
  }

  // -----------------------------------------------------------------
  // First admin staff account - only when both env vars are set, so a
  // fresh checkout never ships a guessable default login.
  // -----------------------------------------------------------------
  const adminEmail = $os.getenv("GG_ADMIN_EMAIL");
  const adminPassword = $os.getenv("GG_ADMIN_PASSWORD");
  if (adminEmail && adminPassword) {
    const staffCollection = app.findCollectionByNameOrId("staff");
    const admin = new Record(staffCollection, {
      email: adminEmail,
      name: "Admin",
      role: "admin",
      active: true,
      verified: true,
    });
    admin.set("password", adminPassword);
    app.save(admin);
    console.log(`Seeded first admin staff account: ${adminEmail}`);
  } else {
    console.log(
      "GG_ADMIN_EMAIL / GG_ADMIN_PASSWORD not set - skipping the first admin staff seed. " +
        "Set both and rerun migrations, or create one later from the dashboard once you have " +
        "another admin, or with a one-off script using app.save(new Record(...)). " +
        "See pb/README.md."
    );
  }
}, (app) => {
  const adminEmail = $os.getenv("GG_ADMIN_EMAIL");
  if (adminEmail) {
    try {
      const admin = app.findFirstRecordByFilter("staff", "email = {:email}", { email: adminEmail });
      app.delete(admin);
    } catch (err) {
      // Nothing to remove.
    }
  }

  for (const key of ["trade_in", "sale", "redemption"]) {
    try {
      app.delete(app.findFirstRecordByFilter("counters", "key = {:key}", { key: key }));
    } catch (err) {
      // Already gone.
    }
  }

  for (const record of app.findRecordsByFilter("settings", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("loyalty_tiers", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("loyalty_programme", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("pricing_rules", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("label_templates", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("locations", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("platforms", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
  for (const record of app.findRecordsByFilter("games", "id != ''", "", 0, 0)) {
    app.delete(record);
  }
});
