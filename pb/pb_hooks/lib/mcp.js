/**
 * GG Vault's own MCP server (docs/api-contract-launch.md, section 5).
 *
 * The Model Context Protocol's JSON-RPC 2.0 over HTTP: `initialize`,
 * `notifications/initialized`, `ping`, `tools/list` and `tools/call`, one
 * message or a batch per POST, answered as `application/json` (mcp.pb.js
 * owns the HTTP side). Stateless: no session id, no server-sent stream.
 *
 * Every tool calls GG Vault's own routes with the caller's own token, over
 * the loopback `api` mcp.pb.js hands in, so the collection rules, the
 * capabilities, the refusals and the audit rows are exactly the ones the
 * counter gets. A refusal comes back as an MCP tool error carrying GG
 * Vault's own sentence. Results are compact JSON: no images, no file
 * tokens, and every amount as integer pence with a `<name>_gbp` beside it
 * in pounds.
 *
 * Plain CommonJS with no PocketBase global outside `formatGBP`'s require,
 * so the dispatch can be read and reasoned about on its own. require() it
 * inside the handler - see pb/README.md on hook isolation.
 */

var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var SERVER_INFO = { name: "ggvault", title: "GG Vault", version: "1.0.0" };
var INSTRUCTIONS =
  "GG Vault is the stock, trade-in, customer, till, bookings and loyalty system of GG Entertainment, " +
  "a games shop in Bolsover. You act with full admin access and everything you do is audited under your name. " +
  "Money is integer GBP pence; a key ending _gbp shows the same amount in pounds. UK sold prices lead every other " +
  "source. For a research request: research_list, research_claim, search ebay.co.uk sold listings (the request's " +
  "ebay_url), then research_complete with the comps you found.";

/** The most text one tool answer may carry. */
var MAX_TEXT = 60000;
/** The most rows any list answers with. */
var MAX_ROWS = 100;

var MONEY_KEYS = {
  price: 1, cost: 1, market_at_intake: 1, net: 1, gross: 1, vat: 1, discounts: 1, refunds: 1, profit: 1,
  average: 1, spend: 1, retail: 1, amount: 1, deposit: 1, paid: 1, entry_fee: 1, member_fee: 1, member_price: 1,
  float: 1, expected: 1, counted: 1, variance: 1, offer_total: 1, market_price: 1, offer_price: 1,
  payout_cash: 1, payout_credit: 1, total_market: 1, total_offer: 1, gbp_market: 1, condition_adjusted: 1,
  credit_balance: 1, part_exchange_value: 1, refunded_total: 1, subtotal: 1, balance: 1, low: 1, high: 1,
};

function ToolError(message) {
  this.toolError = true;
  this.message = message;
}

function fail(message) {
  throw new ToolError(message);
}

function gbp(pence) {
  var money = require(__hooks + "/lib/shared/money.js");
  return money.formatGBP(pence);
}

/** Adds `<key>_gbp` beside every whole-pence amount under a money key, at any depth. */
function withPounds(value, depth) {
  depth = depth || 0;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) value[i] = withPounds(value[i], depth + 1);
    return value;
  }
  var keys = Object.keys(value);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var v = value[key];
    if (MONEY_KEYS[key] && typeof v === "number" && Math.floor(v) === v && value[key + "_gbp"] === undefined) {
      value[key + "_gbp"] = gbp(v);
    } else if (v && typeof v === "object") {
      value[key] = withPounds(v, depth + 1);
    }
  }
  return value;
}

/** Long lists cut to MAX_ROWS, with a note saying so. */
function capRows(list) {
  if (!Array.isArray(list) || list.length <= MAX_ROWS) return list;
  return list.slice(0, MAX_ROWS);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function str(args, key, opts) {
  opts = opts || {};
  var raw = args[key];
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) fail("Give " + key + ".");
    return "";
  }
  if (typeof raw !== "string" && typeof raw !== "number") fail(key + " must be text.");
  var text = String(raw).trim();
  if (opts.required && !text) fail("Give " + key + ".");
  if (opts.max && text.length > opts.max) fail("Keep " + key + " to " + opts.max + " characters or fewer.");
  if (opts.oneOf && text && opts.oneOf.indexOf(text) < 0) fail(key + " must be one of: " + opts.oneOf.join(", ") + ".");
  return text;
}

function int(args, key, opts) {
  opts = opts || {};
  var raw = args[key];
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) fail("Give " + key + " as a whole number.");
    return opts.fallback === undefined ? null : opts.fallback;
  }
  var n = Number(raw);
  if (!isFinite(n) || Math.floor(n) !== n) fail(key + " must be a whole number.");
  if (opts.min !== undefined && n < opts.min) fail(key + " must be " + opts.min + " or more.");
  if (opts.max !== undefined && n > opts.max) fail(key + " must be " + opts.max + " or less.");
  return n;
}

function bool(args, key) {
  var raw = args[key];
  if (raw === undefined || raw === null) return null;
  if (raw === true || raw === false) return raw;
  fail(key + " must be true or false.");
}

function obj(args, key) {
  var raw = args[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(key + " must be an object.");
  return raw;
}

/** A string for a PocketBase filter between double quotes. */
function esc(text) {
  return String(text).replace(/["\\]/g, "\\$&");
}

function date(args, key, required) {
  var text = str(args, key, { required: required, max: 40 });
  if (text && !/^\d{4}-\d{2}-\d{2}/.test(text)) fail(key + " must be a date, YYYY-MM-DD.");
  return text;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

function pick(source, keys) {
  var out = {};
  for (var i = 0; i < keys.length; i++) {
    var v = source ? source[keys[i]] : undefined;
    if (v !== undefined && v !== null && v !== "") out[keys[i]] = v;
  }
  return out;
}

function itemRow(item) {
  var row = pick(item, [
    "id", "sku", "title", "kind", "condition", "finish", "completeness", "grade_company", "grade",
    "qty", "price", "cost", "status", "show_online", "card", "retro_title",
  ]);
  var expand = item.expand || {};
  if (expand.location) row.location = expand.location.name;
  if (expand.category) row.category = { id: expand.category.id, path: expand.category.path };
  return row;
}

function customerRow(customer, priv) {
  var row = pick(customer, ["id", "name", "code", "email", "phone", "marketing_consent", "birthday_month", "guild_joined_at", "created"]);
  row.guild_member = Boolean(customer.guild_joined_at);
  if (priv) {
    row.credit_balance = priv.credit_balance || 0;
    row.points = priv.points_balance || 0;
    row.id_status = priv.id_status || "none";
    if (priv.flags && priv.flags.length) row.flags = priv.flags;
    if (priv.expand && priv.expand.tier) row.tier = priv.expand.tier.name;
  }
  return row;
}

function priceRow(row) {
  if (!row) return null;
  var out = pick(row, ["source", "gbp_market", "native_currency", "native_market", "fx_rate", "fx_date", "fetched_at", "stale", "evidence_url"]);
  if (out.native_currency && out.native_currency !== "GBP" && typeof out.native_market === "number") {
    out.native_note = "Foreign amount in minor units, shown only beside its GBP conversion.";
  }
  return out;
}

function pricesView(view) {
  return {
    chosen: priceRow(view.chosen),
    condition_adjusted: view.condition_adjusted === undefined ? null : view.condition_adjusted,
    sources: (view.sources || []).map(priceRow),
  };
}

// ---------------------------------------------------------------------------
// Helpers that take a few calls
// ---------------------------------------------------------------------------

/** One item by id or SKU, or a tool error. */
function findItem(api, args) {
  var id = str(args, "id", { max: 40 });
  var sku = str(args, "sku", { max: 40 }).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!id && !sku) fail("Give the item's id or its SKU.");
  var filter = id ? 'id = "' + esc(id) + '"' : 'sku = "' + esc(sku) + '"';
  var page = api.get("/api/collections/items/records", {
    filter: filter,
    perPage: 1,
    expand: "location,category,card,card.set,retro_title,game",
  });
  var item = page.items && page.items[0];
  if (!item) fail("No stock item has that " + (id ? "id" : "SKU") + ". Check it and try again.");
  return item;
}

/** A branch id from an id or a full path ("Trading cards / Pokémon / Singles"). */
function resolveCategory(api, value) {
  var text = String(value || "").trim();
  if (!text) return "";
  var filter = text.indexOf("/") >= 0 ? 'path = "' + esc(text) + '"' : 'id = "' + esc(text) + '" || path = "' + esc(text) + '"';
  var page = api.get("/api/collections/categories/records", { filter: filter, perPage: 1, fields: "id,path" });
  var found = page.items && page.items[0];
  if (!found) fail("No branch is called " + text + ". Use category_tree to see them.");
  return found.id;
}

/** A customer by id or code, with their balances, or a tool error. */
function findCustomer(api, args) {
  var id = str(args, "id", { max: 40 });
  var code = str(args, "code", { max: 40 }).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!id && !code) fail("Give the customer's id or their code.");
  var page = api.get("/api/collections/customers/records", {
    filter: id ? 'id = "' + esc(id) + '"' : 'code = "' + esc(code) + '"',
    perPage: 1,
  });
  var customer = page.items && page.items[0];
  if (!customer) fail("No customer has that " + (id ? "id" : "code") + ". Search for them by name first.");
  var privPage = api.get("/api/collections/customer_private/records", {
    filter: 'customer = "' + esc(customer.id) + '"',
    perPage: 1,
    expand: "tier",
    fields: "credit_balance,points_balance,id_status,flags,expand.tier.name",
  });
  return customerRow(customer, privPage.items && privPage.items[0]);
}

var STOCK_STATUSES = ["in_stock", "reserved", "listed_ebay", "sold", "returned", "written_off", "any"];
var ITEM_KINDS = ["single", "graded", "retro", "sealed", "accessory", "other"];
var CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];
var COMPLETENESS = ["loose", "boxed", "cib"];

function schema(properties, required) {
  return { type: "object", properties: properties, required: required || [], additionalProperties: false };
}

var READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var CHANGE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

var TOOLS = [
  // --- Stock -----------------------------------------------------------------
  {
    name: "stock_search",
    title: "Search stock",
    description:
      "Search the shop's stock by title, SKU, set code, card number or barcode. Defaults to what is in stock; " +
      "status 'any' includes sold. Answers id, SKU, title, condition, quantity, price and cost in pence, location and branch.",
    inputSchema: schema({
      query: { type: "string", description: "Words, a SKU (GG-S-1A2B3C or GGS1A2B3C), a set code or a number." },
      status: { type: "string", enum: STOCK_STATUSES, description: "Default in_stock." },
      kind: { type: "string", enum: ITEM_KINDS },
      category: { type: "string", description: "A branch id or full path; includes everything beneath it." },
      show_online: { type: "boolean", description: "Only stock shown, or not shown, on the website." },
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
    }),
    annotations: READ,
    run: function (args, api) {
      var query = str(args, "query", { max: 200 });
      var status = str(args, "status", { oneOf: STOCK_STATUSES }) || "in_stock";
      var kind = str(args, "kind", { oneOf: ITEM_KINDS });
      var online = bool(args, "show_online");
      var clauses = [];
      if (status !== "any") clauses.push('status = "' + esc(status) + '"');
      if (kind) clauses.push('kind = "' + esc(kind) + '"');
      if (online !== null) clauses.push("show_online = " + (online ? "true" : "false"));
      if (args.category) {
        var branch = resolveCategory(api, args.category);
        clauses.push('(category = "' + esc(branch) + '" || category.lineage ~ "|' + esc(branch) + '|")');
      }
      if (query) {
        var needle = esc(query);
        var code = esc(query.toUpperCase().replace(/[^0-9A-Z]/g, ""));
        var parts = ['title ~ "' + needle + '"', 'set_code ~ "' + needle + '"', 'number ~ "' + needle + '"', 'ean ~ "' + needle + '"'];
        if (code.length >= 3) parts.push('sku ~ "' + code + '"');
        clauses.push("(" + parts.join(" || ") + ")");
      }
      var page = api.get("/api/collections/items/records", {
        filter: clauses.join(" && "),
        sort: "-created",
        page: int(args, "page", { min: 1, fallback: 1 }),
        perPage: int(args, "limit", { min: 1, max: 50, fallback: 20 }),
        expand: "location,category",
      });
      return { total_items: page.totalItems, page: page.page, items: (page.items || []).map(itemRow) };
    },
  },
  {
    name: "stock_get",
    title: "Get a stock item",
    description: "One stock item by id or SKU, with its card or retro title, cost, price, branch, location and notes.",
    inputSchema: schema({ id: { type: "string" }, sku: { type: "string" } }),
    annotations: READ,
    run: function (args, api) {
      var item = findItem(api, args);
      var row = itemRow(item);
      var extra = pick(item, ["set_code", "number", "language", "region", "cert_no", "ean", "market_at_intake", "acquired_at", "source", "notes", "tax_scheme", "vat_rate", "reserved_until"]);
      for (var key in extra) row[key] = extra[key];
      var expand = item.expand || {};
      if (expand.card) {
        row.card_detail = { id: expand.card.id, name: expand.card.name, number: expand.card.number, rarity: expand.card.rarity };
        if (expand.card.expand && expand.card.expand.set) row.card_detail.set = expand.card.expand.set.name;
      }
      if (expand.retro_title) row.retro_detail = { id: expand.retro_title.id, name: expand.retro_title.name, region: expand.retro_title.region };
      if (expand.game) row.game = expand.game.name;
      return row;
    },
  },
  {
    name: "stock_update",
    title: "Update a stock item",
    description:
      "Change a stock item's shelf price (pence), its branch in the category tree, or whether it shows on the website. " +
      "Give the item's id or SKU and only what changes.",
    inputSchema: schema({
      id: { type: "string" },
      sku: { type: "string" },
      price_pence: { type: "integer", minimum: 0, description: "The new shelf price in pence: 1250 is £12.50." },
      category: { type: "string", description: "A branch id or full path, from category_tree." },
      show_online: { type: "boolean" },
    }),
    annotations: CHANGE,
    run: function (args, api) {
      var price = int(args, "price_pence", { min: 0, max: 10000000 });
      var online = bool(args, "show_online");
      var patch = {};
      if (price !== null) patch.price = price;
      if (online !== null) patch.show_online = online;
      if (args.category) patch.category = resolveCategory(api, args.category);
      if (!Object.keys(patch).length) fail("Say what to change: price_pence, category or show_online.");
      var item = findItem(api, args);
      var saved = api.patch("/api/collections/items/records/" + encodeURIComponent(item.id), patch, { expand: "location,category" });
      return itemRow(saved);
    },
  },
  {
    name: "category_tree",
    title: "Category tree",
    description: "Every branch of the stock category tree as its full path and id, for stock_search and stock_update.",
    inputSchema: schema({ query: { type: "string", description: "Only branches whose path contains this." } }),
    annotations: READ,
    run: function (args, api) {
      var query = str(args, "query", { max: 100 }).toLowerCase();
      var tree = api.get("/api/vault/categories/tree");
      var rows = [];
      var list = tree.branches || tree.categories || tree.nodes || [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (query && String(b.path || b.name || "").toLowerCase().indexOf(query) < 0) continue;
        rows.push({ id: b.id, path: b.path || b.name, active: b.active !== false });
      }
      return { branches: capRows(rows), count: rows.length };
    },
  },

  // --- Price check -------------------------------------------------------------
  {
    name: "card_search",
    title: "Find a card",
    description:
      "Find a trading card in the catalogue by name or by set and number ('sv151 199', 'charizard'). " +
      "Answers card ids for card_prices, uk_comp_add and research.",
    inputSchema: schema(
      {
        query: { type: "string" },
        game: { type: "string", description: "pokemon, mtg, yugioh, onepiece or lorcana." },
      },
      ["query"]
    ),
    annotations: READ,
    run: function (args, api) {
      var res = api.get("/api/vault/lookup", { q: str(args, "query", { required: true, max: 200 }), game: str(args, "game", { max: 30 }) });
      return {
        cards: capRows((res.cards || []).map(function (c) {
          return pick(c, ["id", "name", "set_code", "set_name", "number", "rarity", "finishes_available"]);
        })),
      };
    },
  },
  {
    name: "card_prices",
    title: "Price a card",
    description:
      "Every price source for a card in one finish, UK sold comps first, the chosen one marked, with the figure after the " +
      "condition. refresh asks every live source again first (slower).",
    inputSchema: schema(
      {
        card: { type: "string", description: "The card's id." },
        finish: { type: "string", description: "normal, holo, reverse and so on. Default the blank finish." },
        condition: { type: "string", enum: CONDITIONS, description: "Default NM." },
        refresh: { type: "boolean" },
      },
      ["card"]
    ),
    annotations: READ,
    run: function (args, api) {
      var card = str(args, "card", { required: true, max: 40 });
      var finish = str(args, "finish", { max: 60 });
      var condition = str(args, "condition", { oneOf: CONDITIONS }) || "NM";
      var path = "/api/vault/cards/" + encodeURIComponent(card);
      var view = bool(args, "refresh")
        ? api.post(path + "/refresh-prices", { finish: finish, condition: condition })
        : api.get(path + "/prices", { finish: finish, condition: condition });
      return pricesView(view);
    },
  },
  {
    name: "retro_search",
    title: "Find a retro game",
    description:
      "Find a retro game title by name. Searches the titles GG Vault already knows; lookup also asks IGDB (needs the IGDB key).",
    inputSchema: schema(
      {
        query: { type: "string" },
        platform: { type: "string", description: "A platform key such as snes_pal_box, for lookup." },
        lookup: { type: "boolean" },
      },
      ["query"]
    ),
    annotations: READ,
    run: function (args, api) {
      var query = str(args, "query", { required: true, max: 200 });
      if (bool(args, "lookup")) {
        var res = api.get("/api/vault/retro/lookup", { q: query, platform: str(args, "platform", { max: 40 }) });
        return { titles: capRows((res.titles || []).map(function (t) { return pick(t, ["id", "name", "platform", "region"]); })) };
      }
      var page = api.get("/api/collections/retro_titles/records", {
        filter: 'name ~ "' + esc(query) + '"',
        perPage: 25,
        sort: "name",
        expand: "platform",
        fields: "id,name,region,expand.platform.name",
      });
      return {
        titles: (page.items || []).map(function (t) {
          var row = pick(t, ["id", "name", "region"]);
          if (t.expand && t.expand.platform) row.platform = t.expand.platform.name;
          return row;
        }),
      };
    },
  },
  {
    name: "retro_prices",
    title: "Price a retro game",
    description:
      "Every price source for a retro title at a completeness (loose, boxed, cib): UK sold comps, PriceCharting PAL, " +
      "eBay UK asking, PriceCharting NTSC. refresh asks PriceCharting and eBay again first.",
    inputSchema: schema(
      {
        retro_title: { type: "string" },
        completeness: { type: "string", enum: COMPLETENESS, description: "Default loose." },
        refresh: { type: "boolean" },
      },
      ["retro_title"]
    ),
    annotations: READ,
    run: function (args, api) {
      var id = str(args, "retro_title", { required: true, max: 40 });
      var completeness = str(args, "completeness", { oneOf: COMPLETENESS }) || "loose";
      var path = "/api/vault/retro/" + encodeURIComponent(id);
      var view = bool(args, "refresh")
        ? api.post(path + "/refresh-prices", { completeness: completeness })
        : api.get(path + "/prices", { completeness: completeness });
      return pricesView(view);
    },
  },
  {
    name: "uk_comp_add",
    title: "Add a UK sold comp",
    description:
      "Record what one copy sold for on ebay.co.uk in the last 30 days, with the listing's own link (ebay.co.uk/itm/...). " +
      "It leads every other price source for 30 days. For a card give a near-mint price and its finish; for a retro " +
      "title its completeness.",
    inputSchema: schema(
      {
        card: { type: "string" },
        retro_title: { type: "string" },
        price_pence: { type: "integer", minimum: 1, description: "What it sold for, in pence." },
        url: { type: "string", description: "https://www.ebay.co.uk/itm/..." },
        sold_at: { type: "string", description: "YYYY-MM-DD." },
        finish: { type: "string" },
        condition: { type: "string", enum: CONDITIONS },
        completeness: { type: "string", enum: COMPLETENESS },
      },
      ["price_pence", "url", "sold_at"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      var card = str(args, "card", { max: 40 });
      var retro = str(args, "retro_title", { max: 40 });
      if (!card && !retro) fail("Give the card or the retro_title the comp is for.");
      var body = {
        price: int(args, "price_pence", { required: true, min: 1 }),
        url: str(args, "url", { required: true, max: 500 }),
        sold_at: date(args, "sold_at", true),
      };
      var view;
      if (card) {
        body.finish = str(args, "finish", { max: 60 });
        body.condition = str(args, "condition", { oneOf: CONDITIONS }) || "NM";
        view = api.post("/api/vault/cards/" + encodeURIComponent(card) + "/uk-comp", body);
      } else {
        body.completeness = str(args, "completeness", { oneOf: COMPLETENESS }) || "loose";
        view = api.post("/api/vault/retro/" + encodeURIComponent(retro) + "/uk-comp", body);
      }
      return pricesView(view);
    },
  },

  // --- Research ----------------------------------------------------------------
  {
    name: "research_list",
    title: "Research requests",
    description:
      "Requests for UK sold comps, newest first. status open is what is waiting for somebody; each carries its " +
      "search words and the ebay.co.uk sold listings link to start from.",
    inputSchema: schema({
      status: { type: "string", description: "open, claimed, done or cancelled; several with commas. Default open." },
      page: { type: "integer", minimum: 1 },
    }),
    annotations: READ,
    run: function (args, api) {
      var status = str(args, "status", { max: 60 }) || "open";
      var res = api.get("/api/vault/research", { status: status, page: int(args, "page", { min: 1, fallback: 1 }) });
      return res;
    },
  },
  {
    name: "research_create",
    title: "Ask for research",
    description:
      "Open a research request yourself: for a card, a retro title, a stock item, a trade-in line or plain search words.",
    inputSchema: schema({
      query: { type: "string" },
      card: { type: "string" },
      retro_title: { type: "string" },
      item: { type: "string" },
      trade_in_line: { type: "string" },
      condition: { type: "string" },
      finish: { type: "string", description: "A card's finish, or a retro title's completeness." },
    }),
    annotations: WRITE,
    run: function (args, api) {
      var body = {};
      var keys = ["query", "card", "retro_title", "item", "trade_in_line", "condition", "finish"];
      for (var i = 0; i < keys.length; i++) {
        var v = str(args, keys[i], { max: 300 });
        if (v) body[keys[i]] = v;
      }
      return api.post("/api/vault/research", body);
    },
  },
  {
    name: "research_claim",
    title: "Claim a research request",
    description: "Say you are on an open research request, so nobody else picks it up.",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: function (args, api) {
      return api.post("/api/vault/research/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })) + "/claim", {});
    },
  },
  {
    name: "research_complete",
    title: "Complete a research request",
    description:
      "Finish a research request with what you found: a short result in words and up to 20 comps, each a UK eBay sale " +
      "in the last 30 days with its own listing link (ebay.co.uk/itm/...). Each comp is written as a UK sold comp on the " +
      "card or retro title, so it becomes the first price source. Give a card's near-mint sale prices where you can tell.",
    inputSchema: schema(
      {
        id: { type: "string" },
        result: { type: "string", description: "What you found, in a sentence or two. 2,000 characters at most." },
        comps: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              price_pence: { type: "integer", minimum: 1, description: "What it sold for, in pence." },
              sold_at: { type: "string", description: "YYYY-MM-DD." },
              url: { type: "string", description: "https://www.ebay.co.uk/itm/..." },
              title: { type: "string", description: "The listing's title." },
              condition: { type: "string", description: "As the listing describes it." },
            },
            required: ["price_pence", "sold_at", "url"],
            additionalProperties: false,
          },
        },
      },
      ["id", "result"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      var id = str(args, "id", { required: true, max: 40 });
      var result = str(args, "result", { max: 2000 });
      var raw = args.comps === undefined || args.comps === null ? [] : args.comps;
      if (!Array.isArray(raw)) fail("Send comps as a list.");
      var comps = raw.map(function (c) {
        c = c || {};
        return {
          price: c.price_pence !== undefined ? c.price_pence : c.price,
          currency: c.currency || "GBP",
          sold_at: c.sold_at,
          url: c.url,
          title: c.title || "",
          condition: c.condition || "",
        };
      });
      return api.post("/api/vault/research/" + encodeURIComponent(id) + "/complete", { result: result, comps: comps });
    },
  },
  {
    name: "research_cancel",
    title: "Cancel a research request",
    description: "Cancel an open or claimed research request that is no longer needed.",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: CHANGE,
    run: function (args, api) {
      return api.post("/api/vault/research/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })) + "/cancel", {});
    },
  },

  // --- Customers ---------------------------------------------------------------
  {
    name: "customer_search",
    title: "Find a customer",
    description: "Find customers by name, email, phone or customer code. Answers ids, codes, contact details and Guild membership.",
    inputSchema: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]),
    annotations: READ,
    run: function (args, api) {
      var query = str(args, "query", { required: true, max: 120 });
      var needle = esc(query);
      var parts = ['name ~ "' + needle + '"', 'email ~ "' + needle + '"', 'phone ~ "' + needle + '"'];
      var code = query.toUpperCase().replace(/[^0-9A-Z]/g, "");
      if (code.length >= 3) parts.push('code ~ "' + esc(code) + '"');
      var digits = query.replace(/\D/g, "");
      if (digits.length >= 4 && digits !== query) parts.push('phone ~ "' + esc(digits) + '"');
      var page = api.get("/api/collections/customers/records", {
        filter: "(" + parts.join(" || ") + ")",
        sort: "name",
        perPage: int(args, "limit", { min: 1, max: 50, fallback: 20 }),
      });
      return {
        total_items: page.totalItems,
        customers: (page.items || []).map(function (c) { return customerRow(c, null); }),
      };
    },
  },
  {
    name: "customer_get",
    title: "Get a customer",
    description: "One customer by id or code: contact details, Guild membership and tier, store credit, points and ID status.",
    inputSchema: schema({ id: { type: "string" }, code: { type: "string" } }),
    annotations: READ,
    run: function (args, api) {
      return findCustomer(api, args);
    },
  },
  {
    name: "guild_join",
    title: "Join the Guild",
    description:
      "Join a customer to the GG Guild (free), or create a new customer who joins. Give customer for an existing one, or " +
      "a name with an email or phone for a new one. marketing_consent is what they agreed to.",
    inputSchema: schema(
      {
        customer: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        marketing_consent: { type: "boolean" },
        birthday_month: { type: "integer", minimum: 1, maximum: 12 },
      },
      ["marketing_consent"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      var body = { marketing_consent: bool(args, "marketing_consent") === true };
      var keys = ["customer", "name", "email", "phone"];
      for (var i = 0; i < keys.length; i++) {
        var v = str(args, keys[i], { max: 200 });
        if (v) body[keys[i]] = v;
      }
      var month = int(args, "birthday_month", { min: 1, max: 12 });
      if (month !== null) body.birthday_month = month;
      return api.post("/api/vault/guild/join", body);
    },
  },

  // --- Sales and reports -------------------------------------------------------
  {
    name: "dashboard",
    title: "Sales dashboard",
    description:
      "Sales, cost, profit, margin, buy-in spend, stock value, sales by day and by category, top items and the payment mix " +
      "for a date range, with the previous period to compare.",
    inputSchema: schema(
      {
        from: { type: "string", description: "YYYY-MM-DD." },
        to: { type: "string", description: "YYYY-MM-DD." },
        compare: { type: "boolean", description: "Add the previous period of the same length." },
      },
      ["from", "to"]
    ),
    annotations: READ,
    run: function (args, api) {
      var query = { from: date(args, "from", true), to: date(args, "to", true) };
      if (bool(args, "compare")) query.compare = "previous";
      return api.get("/api/vault/reports/dashboard", query);
    },
  },
  {
    name: "report",
    title: "Run a report",
    description:
      "Any report by key for a date range: sales, buyins, margin, stock, channels, customers, loyalty, cash, compliance " +
      "(and vat, with period instead of a range, where present). Answers its totals and its table.",
    inputSchema: schema(
      {
        key: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD." },
        to: { type: "string", description: "YYYY-MM-DD." },
        group: { type: "string", enum: ["day", "week", "month"] },
        by: { type: "string", description: "A dimension the report offers, such as category." },
        compare: { type: "boolean" },
        period: { type: "string", description: "For vat: 2026-Q4." },
      },
      ["key"]
    ),
    annotations: READ,
    run: function (args, api) {
      var key = str(args, "key", { required: true, max: 40 });
      if (!/^[a-z_]+$/.test(key)) fail("key is a report name such as sales or margin.");
      var query = {
        from: date(args, "from", false),
        to: date(args, "to", false),
        group: str(args, "group", { oneOf: ["day", "week", "month"] }),
        by: str(args, "by", { max: 40 }),
        period: str(args, "period", { max: 10 }),
      };
      if (bool(args, "compare")) query.compare = "previous";
      var res = api.get("/api/vault/reports/" + key, query);
      if (res && res.table && Array.isArray(res.table.rows) && res.table.rows.length > MAX_ROWS) {
        res.table.rows_total = res.table.rows.length;
        res.table.rows = res.table.rows.slice(0, MAX_ROWS);
      }
      return res;
    },
  },
  {
    name: "till_x",
    title: "The X running now",
    description:
      "The till's running X report right now: the open session, sales, refunds, tenders, cash expected in the drawer. " +
      "Nothing is printed or saved.",
    inputSchema: schema({ register: { type: "string", description: "A register id. Default the counter." } }),
    annotations: READ,
    run: function (args, api) {
      return api.get("/api/vault/till/current", { register: str(args, "register", { max: 40 }) });
    },
  },

  // --- Bookings and events -----------------------------------------------------
  {
    name: "bookings_availability",
    title: "Free slots",
    description: "The free slots on a day for each table, PC, console or room, within their hours.",
    inputSchema: schema(
      {
        date: { type: "string", description: "YYYY-MM-DD." },
        kind: { type: "string", enum: ["table", "pc", "console", "room"] },
        party: { type: "integer", minimum: 1 },
      },
      ["date"]
    ),
    annotations: READ,
    run: function (args, api) {
      return api.get("/api/vault/bookings/availability", {
        date: date(args, "date", true),
        kind: str(args, "kind", { oneOf: ["table", "pc", "console", "room"] }),
        party: int(args, "party", { min: 1, max: 100 }),
      });
    },
  },
  {
    name: "bookings_list",
    title: "Bookings",
    description: "Bookings between two dates, earliest first, with the resource or event, the name, the party and what is paid.",
    inputSchema: schema({
      from: { type: "string", description: "YYYY-MM-DD. Default today." },
      to: { type: "string", description: "YYYY-MM-DD. Default a week after from." },
      status: { type: "string", enum: ["held", "confirmed", "checked_in", "completed", "cancelled", "no_show"] },
    }),
    annotations: READ,
    run: function (args, api) {
      var from = date(args, "from", false) || new Date().toISOString().slice(0, 10);
      var to = date(args, "to", false);
      if (!to) to = new Date(new Date(from + "T00:00:00Z").getTime() + 7 * 864e5).toISOString().slice(0, 10);
      var clauses = ['starts_at >= "' + esc(from) + ' 00:00:00"', 'starts_at <= "' + esc(to) + ' 23:59:59"'];
      var status = str(args, "status", { max: 20 });
      if (status) clauses.push('status = "' + esc(status) + '"');
      var page = api.get("/api/collections/bookings/records", {
        filter: clauses.join(" && "),
        sort: "starts_at",
        perPage: MAX_ROWS,
        expand: "resource,event,customer",
      });
      return {
        total_items: page.totalItems,
        bookings: (page.items || []).map(function (b) {
          var row = pick(b, ["id", "kind", "status", "starts_at", "ends_at", "party_size", "name", "phone", "price", "deposit", "paid", "source", "notes"]);
          var x = b.expand || {};
          if (x.resource) row.resource = x.resource.name;
          if (x.event) row.event = x.event.name;
          if (x.customer) row.customer = { id: x.customer.id, name: x.customer.name, code: x.customer.code };
          return row;
        }),
      };
    },
  },
  {
    name: "booking_create",
    title: "Book",
    description:
      "Book a table, PC, console or room by the slot, or an entry to an event. Checks hours, overlap and capacity and " +
      "prices it (members' prices for a Guild member). Paid at the till.",
    inputSchema: schema(
      {
        kind: { type: "string", enum: ["resource", "event"] },
        resource: { type: "string" },
        event: { type: "string" },
        customer: { type: "string" },
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        starts_at: { type: "string", description: "ISO 8601, for example 2026-10-17T18:00:00Z." },
        ends_at: { type: "string" },
        party_size: { type: "integer", minimum: 1 },
        notes: { type: "string" },
        source: { type: "string", enum: ["till", "online", "phone"] },
      },
      ["kind"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      var body = {};
      var keys = ["kind", "resource", "event", "customer", "name", "phone", "email", "starts_at", "ends_at", "notes", "source"];
      for (var i = 0; i < keys.length; i++) {
        var v = str(args, keys[i], { max: 2000 });
        if (v) body[keys[i]] = v;
      }
      var party = int(args, "party_size", { min: 1, max: 500 });
      if (party !== null) body.party_size = party;
      if (!body.source) body.source = "phone";
      return api.post("/api/vault/bookings", body);
    },
  },
  {
    name: "booking_move",
    title: "Move a booking",
    description: "Move a booking to another time, and optionally another resource.",
    inputSchema: schema(
      {
        id: { type: "string" },
        starts_at: { type: "string" },
        ends_at: { type: "string" },
        resource: { type: "string" },
      },
      ["id", "starts_at"]
    ),
    annotations: CHANGE,
    run: function (args, api) {
      var body = { starts_at: str(args, "starts_at", { required: true, max: 40 }) };
      var ends = str(args, "ends_at", { max: 40 });
      if (ends) body.ends_at = ends;
      var resource = str(args, "resource", { max: 40 });
      if (resource) body.resource = resource;
      return api.post("/api/vault/bookings/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })) + "/move", body);
    },
  },
  {
    name: "booking_cancel",
    title: "Cancel a booking",
    description: "Cancel a booking, keeping the deposit or refunding it.",
    inputSchema: schema(
      {
        id: { type: "string" },
        refund_deposit: { type: "boolean" },
        reason: { type: "string" },
      },
      ["id"]
    ),
    annotations: CHANGE,
    run: function (args, api) {
      var body = { refund_deposit: bool(args, "refund_deposit") === true };
      var reason = str(args, "reason", { max: 500 });
      if (reason) body.reason = reason;
      return api.post("/api/vault/bookings/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })) + "/cancel", body);
    },
  },
  {
    name: "events_list",
    title: "Events",
    description: "Tournaments and events from a date on, with capacity, fees and status.",
    inputSchema: schema({
      from: { type: "string", description: "YYYY-MM-DD. Default today." },
      status: { type: "string", enum: ["draft", "published", "cancelled", "finished"] },
    }),
    annotations: READ,
    run: function (args, api) {
      var from = date(args, "from", false) || new Date().toISOString().slice(0, 10);
      var clauses = ['starts_at >= "' + esc(from) + ' 00:00:00"'];
      var status = str(args, "status", { max: 20 });
      if (status) clauses.push('status = "' + esc(status) + '"');
      var page = api.get("/api/collections/booking_events/records", {
        filter: clauses.join(" && "),
        sort: "starts_at",
        perPage: MAX_ROWS,
        expand: "game",
      });
      return {
        events: (page.items || []).map(function (ev) {
          var row = pick(ev, ["id", "name", "format", "starts_at", "ends_at", "capacity", "entry_fee", "member_fee", "online", "status", "repeat_weekly", "description"]);
          if (ev.expand && ev.expand.game) row.game = ev.expand.game.name;
          return row;
        }),
      };
    },
  },
  {
    name: "event_create",
    title: "Create an event",
    description: "Create a tournament or event. Fees are in pence. A draft is not shown to customers until published.",
    inputSchema: schema(
      {
        name: { type: "string" },
        starts_at: { type: "string", description: "ISO 8601." },
        ends_at: { type: "string", description: "ISO 8601." },
        game: { type: "string", description: "A game id." },
        format: { type: "string" },
        capacity: { type: "integer", minimum: 0 },
        entry_fee_pence: { type: "integer", minimum: 0 },
        member_fee_pence: { type: "integer", minimum: 0 },
        online: { type: "boolean" },
        status: { type: "string", enum: ["draft", "published"] },
        repeat_weekly: { type: "boolean" },
        description: { type: "string" },
      },
      ["name", "starts_at", "ends_at"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      var body = {
        name: str(args, "name", { required: true, max: 120 }),
        starts_at: str(args, "starts_at", { required: true, max: 40 }),
        ends_at: str(args, "ends_at", { required: true, max: 40 }),
        status: str(args, "status", { oneOf: ["draft", "published"] }) || "draft",
      };
      var texts = ["game", "format", "description"];
      for (var i = 0; i < texts.length; i++) {
        var v = str(args, texts[i], { max: 4000 });
        if (v) body[texts[i]] = v;
      }
      var capacity = int(args, "capacity", { min: 0, max: 10000 });
      if (capacity !== null) body.capacity = capacity;
      var fee = int(args, "entry_fee_pence", { min: 0, max: 1000000 });
      if (fee !== null) body.entry_fee = fee;
      var memberFee = int(args, "member_fee_pence", { min: 0, max: 1000000 });
      if (memberFee !== null) body.member_fee = memberFee;
      var online = bool(args, "online");
      if (online !== null) body.online = online;
      var repeat = bool(args, "repeat_weekly");
      if (repeat !== null) body.repeat_weekly = repeat;
      var saved = api.post("/api/collections/booking_events/records", body);
      return pick(saved, ["id", "name", "starts_at", "ends_at", "capacity", "entry_fee", "member_fee", "online", "status", "repeat_weekly"]);
    },
  },

  // --- Trade-ins and quotes ----------------------------------------------------
  {
    name: "tradeins_list",
    title: "Buy-ins",
    description: "Buy-ins (trade-ins), newest first: number, status, customer, totals and how they were paid.",
    inputSchema: schema({
      status: { type: "string", enum: ["draft", "offered", "accepted", "completed", "declined", "cancelled"] },
      customer: { type: "string", description: "A customer id." },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    annotations: READ,
    run: function (args, api) {
      var clauses = [];
      var status = str(args, "status", { max: 20 });
      if (status) clauses.push('status = "' + esc(status) + '"');
      var customer = str(args, "customer", { max: 40 });
      if (customer) clauses.push('customer = "' + esc(customer) + '"');
      var page = api.get("/api/collections/trade_ins/records", {
        filter: clauses.join(" && "),
        sort: "-created",
        perPage: int(args, "limit", { min: 1, max: 50, fallback: 20 }),
        expand: "customer",
      });
      return {
        total_items: page.totalItems,
        trade_ins: (page.items || []).map(function (t) {
          var row = pick(t, ["id", "number", "status", "channel", "payout_type", "total_market", "total_offer", "payout_cash", "payout_credit", "created", "completed_at"]);
          if (t.expand && t.expand.customer) row.customer = { id: t.expand.customer.id, name: t.expand.customer.name, code: t.expand.customer.code };
          return row;
        }),
      };
    },
  },
  {
    name: "tradein_get",
    title: "Get a buy-in",
    description: "One buy-in by id or number (GG-BI-000123) with its lines: what each is, condition, market, offer.",
    inputSchema: schema({ id: { type: "string" }, number: { type: "string" } }),
    annotations: READ,
    run: function (args, api) {
      var id = str(args, "id", { max: 40 });
      var number = str(args, "number", { max: 40 }).toUpperCase();
      if (!id && !number) fail("Give the buy-in's id or its number.");
      var page = api.get("/api/collections/trade_ins/records", {
        filter: id ? 'id = "' + esc(id) + '"' : 'number = "' + esc(number) + '"',
        perPage: 1,
        expand: "customer",
      });
      var trade = page.items && page.items[0];
      if (!trade) fail("No buy-in has that " + (id ? "id" : "number") + ".");
      var row = pick(trade, ["id", "number", "status", "channel", "payout_type", "total_market", "total_offer", "payout_cash", "payout_credit", "id_checked", "created", "completed_at"]);
      if (trade.expand && trade.expand.customer) row.customer = { id: trade.expand.customer.id, name: trade.expand.customer.name, code: trade.expand.customer.code };
      var lines = api.get("/api/collections/trade_in_lines/records", {
        filter: 'trade_in = "' + esc(trade.id) + '"',
        sort: "created",
        perPage: MAX_ROWS,
        expand: "card,retro_title",
      });
      row.lines = (lines.items || []).map(function (l) {
        var line = pick(l, ["id", "kind", "free_text_title", "finish", "condition", "completeness", "qty", "market_price", "market_source", "offer_price", "accepted", "override_reason"]);
        var x = l.expand || {};
        if (x.card) line.card = { id: x.card.id, name: x.card.name, number: x.card.number };
        if (x.retro_title) line.retro_title = { id: x.retro_title.id, name: x.retro_title.name };
        return line;
      });
      return row;
    },
  },
  {
    name: "quotes_list",
    title: "Remote quotes",
    description: "Quotes customers sent from My Vault, newest first: status, customer, message, offer.",
    inputSchema: schema({
      status: { type: "string", enum: ["submitted", "reviewing", "offered", "accepted", "declined", "expired", "received", "completed"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    annotations: READ,
    run: function (args, api) {
      var status = str(args, "status", { max: 20 });
      var page = api.get("/api/collections/quotes/records", {
        filter: status ? 'status = "' + esc(status) + '"' : "",
        sort: "-created",
        perPage: int(args, "limit", { min: 1, max: 50, fallback: 20 }),
        expand: "customer",
        fields: "id,status,message,offer_total,offer_expires_at,drop_off,created,expand.customer.id,expand.customer.name,expand.customer.code",
      });
      return {
        total_items: page.totalItems,
        quotes: (page.items || []).map(function (q) {
          var row = pick(q, ["id", "status", "message", "offer_total", "offer_expires_at", "drop_off", "created"]);
          if (q.expand && q.expand.customer) row.customer = q.expand.customer;
          return row;
        }),
      };
    },
  },
  {
    name: "quote_get",
    title: "Get a quote",
    description: "One remote quote with its lines and its message thread. Photos are left out.",
    inputSchema: schema({ id: { type: "string" } }, ["id"]),
    annotations: READ,
    run: function (args, api) {
      var res = api.get("/api/vault/quotes/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })));
      return stripImages(res);
    },
  },
  {
    name: "quote_offer",
    title: "Make a quote offer",
    description:
      "Put an offer on a submitted or reviewing quote: one line per thing, market and offer in pence. The customer is " +
      "notified at once and can accept or decline in My Vault.",
    inputSchema: schema(
      {
        id: { type: "string" },
        lines: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              card: { type: "string" },
              retro_title: { type: "string" },
              condition: { type: "string" },
              finish: { type: "string" },
              qty: { type: "integer", minimum: 1 },
              market_price: { type: "integer", minimum: 0, description: "Pence." },
              market_source: { type: "string" },
              offer_price: { type: "integer", minimum: 0, description: "Pence, each." },
            },
            required: ["qty", "market_price", "offer_price"],
          },
        },
        message: { type: "string" },
      },
      ["id", "lines"]
    ),
    annotations: WRITE,
    run: function (args, api) {
      if (!Array.isArray(args.lines) || !args.lines.length) fail("Give at least one line.");
      var body = { lines: args.lines };
      var message = str(args, "message", { max: 2000 });
      if (message) body.message = message;
      return stripImages(api.post("/api/vault/quotes/" + encodeURIComponent(str(args, "id", { required: true, max: 40 })) + "/offer", body));
    },
  },

  // --- Anything else -----------------------------------------------------------
  {
    name: "vault_api",
    title: "Call any GG Vault route",
    description:
      "Call any other GG Vault API route as yourself, for what the other tools do not cover: /api/vault/... routes and " +
      "/api/collections/<name>/records. Rules, capabilities and the audit log apply as for any member of staff. " +
      "Routes that need a person's password (refunds, ID photos, staff changes) are refused to agents.",
    inputSchema: schema(
      {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string", description: "Starts with /api/, for example /api/vault/fx." },
        query: { type: "object", description: "Query parameters." },
        body: { type: "object", description: "A JSON body." },
      },
      ["method", "path"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: function (args, api) {
      var method = str(args, "method", { required: true, oneOf: ["GET", "POST", "PATCH", "PUT", "DELETE"] });
      var path = str(args, "path", { required: true, max: 500 });
      if (path.indexOf("/api/") !== 0 || path.indexOf("..") >= 0 || /[\s?#]/.test(path)) {
        fail("path must start with /api/ and carry no query string; put the query in query.");
      }
      if (path === "/api/vault/mcp" || path.indexOf("/api/vault/mcp/") === 0) fail("Call the tools directly, not the MCP endpoint.");
      var query = obj(args, "query") || {};
      var body = obj(args, "body");
      var res = api.send(method, path, query, body === null ? undefined : body);
      return stripImages(res);
    },
  },
];

/** Drops photo, image and file-token fields at any depth: no images in answers. */
function stripImages(value, depth) {
  depth = depth || 0;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(function (v) { return stripImages(v, depth + 1); });
  var out = {};
  for (var key in value) {
    if (/^(photos?|images?|image_small|image_large|image_file|cover|signature|photo_urls?)$/.test(key)) continue;
    out[key] = stripImages(value[key], depth + 1);
  }
  return out;
}

function toolByName(name) {
  for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) return TOOLS[i];
  return null;
}

function toolList() {
  return TOOLS.map(function (tool) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    };
  });
}

/**
 * Run one tool. Returns `{ result, ok, status }`: `result` is the MCP
 * CallToolResult, `ok` and `status` are for the audit row.
 */
function callTool(name, args, api) {
  var tool = toolByName(name);
  if (!tool) return null;
  try {
    var value = tool.run(args && typeof args === "object" && !Array.isArray(args) ? args : {}, api);
    var text = JSON.stringify(withPounds(value === undefined ? { ok: true } : value));
    if (text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT) + " [cut: the answer was too long; narrow the request]";
    }
    return { ok: true, status: 200, result: { content: [{ type: "text", text: text }], isError: false } };
  } catch (err) {
    var message = err && err.toolError ? err.message : null;
    var status = err && err.status ? err.status : 0;
    if (!message) {
      console.log("[mcp] tool " + name + " failed: " + err);
      message = "That did not work. GG Vault could not finish " + name + ". Try again, or ask a member of staff.";
    }
    return { ok: false, status: status, result: { content: [{ type: "text", text: message }], isError: true } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code: code, message: message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

/**
 * One JSON-RPC message in, one response object out, or null for a
 * notification or a response (which get nothing back). `ctx.api` is the
 * loopback; `ctx.audit(tool, ok, status, extra)` writes the tool call's row.
 */
function handle(message, ctx) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid request: send a JSON-RPC 2.0 object.");
  }
  var hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== null;
  if (typeof message.method !== "string") {
    // A response to something the server never asks, or junk: nothing to say.
    return hasId && message.result === undefined && message.error === undefined
      ? rpcError(message.id, -32600, "Invalid request: a method is needed.")
      : null;
  }
  if (message.jsonrpc !== "2.0") return hasId ? rpcError(message.id, -32600, "Invalid request: jsonrpc must be 2.0.") : null;
  if (!hasId) return null; // notifications/initialized, notifications/cancelled and the like

  var params = message.params && typeof message.params === "object" ? message.params : {};
  switch (message.method) {
    case "initialize": {
      var asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      var version = PROTOCOL_VERSIONS.indexOf(asked) >= 0 ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(message.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: toolList() });
    case "tools/call": {
      var name = typeof params.name === "string" ? params.name : "";
      if (!toolByName(name)) return rpcError(message.id, -32602, "Unknown tool: " + (name || "none") + ". Call tools/list.");
      var outcome = callTool(name, params.arguments, ctx.api);
      if (ctx.audit) {
        var extra = {};
        if (name === "vault_api" && params.arguments) {
          extra.method = String(params.arguments.method || "").slice(0, 10);
          extra.path = String(params.arguments.path || "").split("?")[0].slice(0, 200);
        }
        ctx.audit(name, outcome.ok, outcome.status, extra);
      }
      return rpcResult(message.id, outcome.result);
    }
    default:
      return rpcError(message.id, -32601, "Method not found: " + message.method + ".");
  }
}

module.exports = {
  PROTOCOL_VERSIONS: PROTOCOL_VERSIONS,
  SERVER_INFO: SERVER_INFO,
  ToolError: ToolError,
  toolList: toolList,
  callTool: callTool,
  handle: handle,
  rpcError: rpcError,
  withPounds: withPounds,
};
