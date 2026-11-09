#!/usr/bin/env node
/**
 * Reset a GG Vault TEST server to an empty shop: delete the business records,
 * keep the reference data.
 *
 *   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
 *     node pb/scripts/reset-test-data.js --url https://vault-test.example.com --yes
 *
 *   --url URL     the PocketBase base URL (or env PB_URL)
 *   --yes         required to delete anything
 *   --dry-run     print the counts and what would be deleted, delete nothing
 *
 * Refuses to run unless the URL's host contains "vault-test" or is
 * localhost / 127.0.0.1 / ::1. Prints per-collection counts before and after.
 *
 * Deletes (DELETE below): stock, trade-ins and their lines, quotes, sales,
 * cash sessions, bookings, customers with their private rows and ID photos,
 * the loyalty and credit ledgers, research requests, and every other
 * per-customer or per-transaction row. Keeps (KEEP below): the card and
 * retro catalogue, price snapshots and caches, FX, categories, settings
 * and other singletons, staff accounts, devices and printers, and
 * PocketBase's own system collections (including migration state, which
 * is not a collection at all). A collection in neither list is kept and
 * reported, so a new collection is never deleted by surprise.
 *
 * No dependencies: Node 18+ (global fetch).
 */
"use strict";

/** Business collections, in delete order: children before parents. */
const DELETE = [
  // printing and labels pointing at items and sales
  "label_jobs",
  "print_jobs",
  // selling
  "sale_tenders",
  "sale_lines",
  "parked_tickets",
  "sumup_checkouts",
  "sumup_transactions",
  "till_events",
  "till_overrides",
  "till_reports",
  // buying
  "research_requests",
  "trade_in_lines",
  "quote_messages",
  "quotes",
  // stock
  "stock_count_lines",
  "stock_counts",
  "stock_requests",
  "csv_imports",
  "binder_cards",
  "binders",
  // customers' loyalty, credit and notifications
  "reward_redemptions",
  "perk_usage",
  "points_ledger",
  "credit_ledger",
  "referrals",
  "memberships",
  "want_list",
  "notifications",
  "push_subscriptions",
  "notes",
  // bookings
  "booking_events",
  "bookings",
  // the parents
  "items",
  "trade_ins",
  "sales",
  "cash_movements",
  "cash_sessions",
  "id_documents",
  "customer_private",
  "customers",
  // derived from the above
  "daily_stats",
];

/** Reference data and configuration, never touched. */
const KEEP = [
  // catalogue, prices, caches, FX
  "games",
  "card_sets",
  "cards",
  "platforms",
  "retro_titles",
  "price_snapshots",
  "fx_rates",
  "adapter_state",
  // categories and config singletons
  "categories",
  "locations",
  "settings",
  "loyalty_programme",
  "loyalty_rules",
  "loyalty_tiers",
  "loyalty_rewards",
  "pricing_rules",
  "label_templates",
  "display_state",
  "counters",
  "saved_reports",
  "suppliers",
  // staff, devices and the till's own setup
  "staff",
  "users",
  "registers",
  "register_devices",
  "printers",
  "resources",
  "till_keys",
  "till_categories",
  "till_products",
  // the permanent audit trail
  "audit_log",
];

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** True when the URL may be reset: a vault-test host or this machine. */
function hostAllowed(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    return false;
  }
  return host.includes("vault-test") || LOCAL_HOSTS.includes(host);
}

/**
 * Split the server's collection names into what is deleted (in DELETE
 * order), kept, and unclassified (kept, reported). System collections
 * (names starting "_") are always kept.
 */
function classify(names) {
  const present = new Set(names);
  const del = DELETE.filter((n) => present.has(n));
  const keep = [];
  const unknown = [];
  for (const n of names) {
    if (DELETE.includes(n)) continue;
    if (n.startsWith("_") || KEEP.includes(n)) keep.push(n);
    else unknown.push(n);
  }
  return { del, keep: keep.sort(), unknown: unknown.sort() };
}

function parseArgs(argv) {
  const out = { url: process.env.PB_URL || "", yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--url") out.url = argv[++i] || "";
    else if (a.startsWith("--url=")) out.url = a.slice(6);
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`Unknown argument "${a}". Run with --help.`);
  }
  out.url = out.url.replace(/\/+$/, "");
  return out;
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      token ? { Authorization: token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} returned ${res.status}: ${(json && json.message) || text}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function count(base, token, name) {
  const r = await api(base, token, "GET", `/api/collections/${name}/records?perPage=1&fields=id`);
  return r.totalItems;
}

async function counts(base, token, names) {
  const out = {};
  for (const n of names) out[n] = await count(base, token, n);
  return out;
}

function printCounts(title, rows) {
  console.log(`\n${title}`);
  const width = Math.max(...Object.keys(rows).map((k) => k.length), 10);
  for (const [name, n] of Object.entries(rows)) console.log(`  ${name.padEnd(width)}  ${n}`);
}

/** Delete every record in one collection; returns how many could not be deleted. */
async function wipe(base, token, name) {
  let failed = 0;
  const skip = new Set();
  for (;;) {
    const page = await api(base, token, "GET", `/api/collections/${name}/records?perPage=200&fields=id&skipTotal=1`);
    const ids = (page.items || []).map((r) => r.id).filter((id) => !skip.has(id));
    if (ids.length === 0) return failed;
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(
        ids.slice(i, i + 8).map((id) =>
          api(base, token, "DELETE", `/api/collections/${name}/records/${id}`).catch((err) => {
            if (err.status === 404) return; // gone already, by cascade
            skip.add(id);
            failed += 1;
            if (failed <= 3) console.error(`  ${name}/${id}: ${err.message}`);
          })
        )
      );
    }
    if ((page.items || []).every((r) => skip.has(r.id))) return failed;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log(
      "Usage: PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... node pb/scripts/reset-test-data.js --url URL (--yes | --dry-run)"
    );
    process.exit(args.help ? 0 : 2);
  }
  if (!hostAllowed(args.url)) {
    console.error(
      `Refusing to reset ${args.url}: the host must contain "vault-test" or be localhost or 127.0.0.1.`
    );
    process.exit(2);
  }
  if (!args.yes && !args.dryRun) {
    console.error("Refusing to delete without --yes. Add --dry-run to see the counts only.");
    process.exit(2);
  }
  const email = process.env.PB_SUPERUSER_EMAIL;
  const password = process.env.PB_SUPERUSER_PASSWORD;
  if (!email || !password) {
    console.error("Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD to a superuser on that server.");
    process.exit(2);
  }

  const auth = await api(args.url, "", "POST", "/api/collections/_superusers/auth-with-password", {
    identity: email,
    password,
  });
  const token = auth.token;

  const list = await api(args.url, token, "GET", "/api/collections?perPage=500&fields=name,type");
  const names = (list.items || []).filter((c) => c.type !== "view").map((c) => c.name);
  const plan = classify(names);

  console.log(`Server: ${args.url}`);
  console.log(`Deleting from ${plan.del.length} collections; keeping ${plan.keep.length}.`);
  console.log(`Keep: ${plan.keep.join(", ")}`);
  if (plan.unknown.length) {
    console.log(`Not classified, so kept: ${plan.unknown.join(", ")}. Add them to DELETE or KEEP in this script.`);
  }

  printCounts("Before (deleted collections):", await counts(args.url, token, plan.del));
  const keptBefore = await counts(args.url, token, plan.keep.filter((n) => !n.startsWith("_")));
  printCounts("Before (kept collections):", keptBefore);

  if (args.dryRun) {
    console.log("\nDry run: nothing deleted.");
    return;
  }

  let failed = 0;
  // Two passes: a row still referenced by a not-yet-deleted parent is
  // retried once its referrer has gone.
  for (let pass = 1; pass <= 2; pass++) {
    failed = 0;
    for (const name of plan.del) failed += await wipe(args.url, token, name);
    if (failed === 0) break;
  }

  printCounts("After (deleted collections):", await counts(args.url, token, plan.del));
  const keptAfter = await counts(args.url, token, plan.keep.filter((n) => !n.startsWith("_")));
  printCounts("After (kept collections):", keptAfter);
  for (const n of Object.keys(keptBefore)) {
    if (keptAfter[n] !== keptBefore[n]) console.log(`Note: ${n} went from ${keptBefore[n]} to ${keptAfter[n]} (delete hooks write audit rows; a cascade would show here too).`);
  }
  if (failed) {
    console.error(`\n${failed} records could not be deleted. See the errors above.`);
    process.exit(1);
  }
  console.log("\nDone.");
}

module.exports = { DELETE, KEEP, hostAllowed, classify, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
