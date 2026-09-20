/**
 * lib/labels.js - the bulk reprint selector and the cross-device print
 * queue behind labels.pb.js. See docs/api-contract.md's Phase 7 section
 * for the routes and shapes.
 *
 * A label job has always been a row in `label_jobs` that the print page
 * at `/labels/print` reads and marks printed. Phase 7 adds the two things
 * a shop with more than one device needs:
 *
 *  - **a claim**, so two counters printing at once cannot both send the
 *    same label. Claiming flips a batch of `queued` jobs to `printing`
 *    with the claiming device's name, inside one transaction that
 *    re-reads each row's status before it writes, so the loser of a race
 *    gets the next batch rather than a second copy of the first;
 *  - **a way back**, so a job a device died holding is not lost: a
 *    failure puts it back in the queue with the reason on it (three
 *    failures and it stops trying), and the `labels_unstick` cron does
 *    the same for a claim nobody ever finished.
 *
 * Every refusal is returned as `{ok:false,status,message}` rather than
 * thrown, so the route raises it with its own status code and the wording
 * lives in one place (the same shape lib/perks.js and lib/readers.js
 * use).
 *
 * require() this from inside each handler/cron body, not at file top
 * level - see pb/README.md.
 */

/** Stock this shop still physically holds, which is all a label is ever for. */
var HELD_STATUSES = ["in_stock", "reserved", "listed_ebay"];
var MAX_BATCH = 500;
var MAX_COPIES = 20;
var DEFAULT_CLAIM_LIMIT = 10;
var MAX_CLAIM_LIMIT = 50;
var MAX_ATTEMPTS = 3;
var STUCK_AFTER_MS = 10 * 60 * 1000;

/** PocketBase's own stored date shape ("2026-09-20 12:00:00.000Z"). */
function pbDate(d) {
  return d.toISOString().replace("T", " ");
}

/** A stored date read back as a Date, whichever separator it carries. */
function parseStored(value) {
  if (!value) return null;
  var d = new Date(String(value).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Which label template a finished item wants - the same table the buy-in
 * wizard's own completion route uses (tradeins.pb.js), so a reprint comes
 * out on the size the original did.
 */
function templateKeyFor(kind, completeness) {
  if (kind === "single" || kind === "graded") return "toploader_40x20";
  if (kind === "retro") return "retro_50x30";
  if (kind === "sealed" || kind === "accessory") {
    return completeness === "boxed" || completeness === "cib" ? "retro_50x30" : "sleeve_25x15";
  }
  return "toploader_40x20";
}

/** Every label template by key, and by id. */
function templates(app) {
  var byKey = {};
  var byId = {};
  var rows = [];
  try {
    rows = app.findRecordsByFilter("label_templates", "id != ''", "key", 0, 0);
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i]) continue;
    byKey[rows[i].getString("key")] = rows[i];
    byId[rows[i].id] = rows[i];
  }
  return { byKey: byKey, byId: byId };
}

/** The template row for one item: the requested key, else the kind's own, else the settings default. */
function templateForItem(item, requested, table, fallbackId) {
  if (requested) return requested;
  var own = table.byKey[templateKeyFor(item.getString("kind"), item.getString("completeness"))];
  if (own) return own;
  return fallbackId && table.byId[fallbackId] ? table.byId[fallbackId] : null;
}

/** One `{status: "queued" | "printing"}` job per item id, for the skip rule. */
function openJobsByItem(app) {
  var map = {};
  var rows = [];
  try {
    rows = app.findRecordsByFilter("label_jobs", '(status = "queued" || status = "printing")', "", 0, 0);
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) map[rows[i].getString("item")] = rows[i].getString("status");
  }
  return map;
}

/**
 * The items one queue request is about.
 *
 * Every selector narrows the same query, and every one of them is bounded
 * to stock this shop still holds: a sold, returned or written-off item is
 * never labelled, however it was asked for.
 *
 * @returns {{ok:boolean, status?:number, message?:string, items?:object[]}}
 */
function resolveItems(app, selector) {
  var csv = require(__hooks + "/lib/csv.js");
  var sel = selector || {};
  // Built from HELD_STATUSES rather than written out, so "what a label is
  // ever for" is stated once in this file.
  var held = [];
  for (var h = 0; h < HELD_STATUSES.length; h++) held.push('status = "' + HELD_STATUSES[h] + '"');
  var parts = ["(" + held.join(" || ") + ")"];
  var params = {};
  var used = 0;

  if (sel.items && sel.items.length) {
    var ors = [];
    for (var i = 0; i < sel.items.length; i++) {
      var key = "i" + i;
      ors.push("id = {:" + key + "}");
      params[key] = String(sel.items[i]);
    }
    parts.push("(" + ors.join(" || ") + ")");
    used += 1;
  }
  if (sel.tradeIn) {
    parts.push("trade_in_line.trade_in = {:tradeIn}");
    params.tradeIn = sel.tradeIn;
    used += 1;
  }
  if (sel.acquiredFrom) {
    if (!csv.isValidDateStr(sel.acquiredFrom)) {
      return { ok: false, status: 400, message: "The from date has to be a real date, YYYY-MM-DD." };
    }
    parts.push("acquired_at >= {:from}");
    params.from = sel.acquiredFrom + " 00:00:00.000Z";
    used += 1;
  }
  if (sel.acquiredTo) {
    if (!csv.isValidDateStr(sel.acquiredTo)) {
      return { ok: false, status: 400, message: "The to date has to be a real date, YYYY-MM-DD." };
    }
    parts.push("acquired_at <= {:to}");
    params.to = sel.acquiredTo + " 23:59:59.999Z";
    used += 1;
  }
  if (sel.location) {
    parts.push("location = {:location}");
    params.location = sel.location;
    used += 1;
  }
  if (sel.kind) {
    parts.push("kind = {:kind}");
    params.kind = sel.kind;
    used += 1;
  }
  if (sel.game) {
    parts.push("game = {:game}");
    params.game = sel.game;
    used += 1;
  }

  if (used === 0) {
    return {
      ok: false,
      status: 400,
      message: "Pick what to print: the items, a buy-in, a date range, a location, a kind or a game.",
    };
  }

  var rows = [];
  try {
    rows = app.findRecordsByFilter("items", parts.join(" && "), "created,id", 0, 0, params);
  } catch (err) {
    rows = [];
  }
  var items = [];
  for (var r = 0; r < rows.length; r++) {
    if (rows[r]) items.push(rows[r]);
  }
  return { ok: true, items: items };
}

/**
 * Queue a label per resolved item.
 *
 * `skipped` counts items that already have a `queued` or `printing` job
 * and were left alone; an item the selector matched but this shop no
 * longer holds never reaches this at all (see resolveItems above).
 *
 * @returns {{ok:boolean, status?:number, message?:string, queued?:number, skipped?:number, jobIds?:string[]}}
 */
function queue(app, opts) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var auditLib = require(__hooks + "/lib/audit.js");
  var options = opts || {};

  var copies = options.copies === undefined || options.copies === null ? 1 : util.asInt(options.copies, 1);
  if (copies < 1 || copies > MAX_COPIES) {
    return { ok: false, status: 400, message: "Copies has to be a whole number between 1 and " + MAX_COPIES + "." };
  }

  var table = templates(app);
  var requested = null;
  if (options.templateKey) {
    requested = table.byKey[options.templateKey];
    if (!requested) {
      return {
        ok: false,
        status: 400,
        message: "No label template with that name. Pick one from the templates list.",
      };
    }
  }

  var resolved = resolveItems(app, options.selector);
  if (!resolved.ok) return resolved;

  var items = resolved.items;
  if (items.length > MAX_BATCH) {
    return {
      ok: false,
      status: 400,
      message: "That is " + items.length + " labels. Narrow the range to " + MAX_BATCH + " or fewer.",
    };
  }
  if (items.length === 0) {
    return { ok: true, status: 200, queued: 0, skipped: 0, jobIds: [] };
  }

  var settingsRow = util.settings(app);
  var fallbackId = settingsRow ? settingsRow.getString("label_default_template") : "";
  var open = options.includeQueued ? {} : openJobsByItem(app);

  var jobIds = [];
  var skipped = 0;
  app.runInTransaction(function (txApp) {
    var collection = txApp.findCollectionByNameOrId("label_jobs");
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (open[item.id]) {
        skipped += 1;
        continue;
      }
      var template = templateForItem(item, requested, table, fallbackId);
      if (!template) {
        skipped += 1;
        continue;
      }
      var job = new Record(collection, {
        item: item.id,
        template: template.id,
        copies: copies,
        status: "queued",
        attempts: 0,
      });
      if (options.staffId) job.set("requested_by", options.staffId);
      txApp.save(job);
      jobIds.push(job.id);
    }

    auditLib.writeAuditLog(txApp, {
      actor: options.staffId || "system",
      action: "labels_queued",
      collection: "label_jobs",
      record: "",
      // Counts, the selector that produced them and at most twenty ids -
      // never a whole batch of 500, for the same reason Phase 4's own
      // export audits cap theirs.
      meta: {
        queued: jobIds.length,
        skipped: skipped,
        copies: copies,
        selector: options.selectorSummary || {},
        job_count: jobIds.length,
        jobs: jobIds.slice(0, 20),
      },
      ip: options.ip || "",
    });
  });

  return { ok: true, status: 200, queued: jobIds.length, skipped: skipped, jobIds: jobIds };
}

/** One job as every route in this package returns it, item and template resolved. */
function jobShape(app, job) {
  if (!job) return null;
  var item = null;
  try {
    item = app.findRecordById("items", job.getString("item"));
  } catch (err) {
    item = null;
  }
  var template = null;
  try {
    template = app.findRecordById("label_templates", job.getString("template"));
  } catch (err) {
    template = null;
  }
  var gameKey = "";
  if (item && item.getString("game")) {
    try {
      gameKey = app.findRecordById("games", item.getString("game")).getString("key");
    } catch (err) {
      gameKey = "";
    }
  }

  return {
    id: job.id,
    status: job.getString("status"),
    copies: job.getInt("copies") || 1,
    attempts: job.getInt("attempts"),
    printer: job.getString("printer"),
    claimed_at: job.getString("claimed_at"),
    printed_at: job.getString("printed_at"),
    error: job.getString("error"),
    template: template
      ? {
          id: template.id,
          key: template.getString("key"),
          width_mm: template.getInt("width_mm"),
          height_mm: template.getInt("height_mm"),
          dpi: template.getInt("dpi"),
        }
      : null,
    item: item
      ? {
          id: item.id,
          sku: item.getString("sku"),
          title: item.getString("title"),
          set_code: item.getString("set_code"),
          number: item.getString("number"),
          finish: item.getString("finish"),
          condition: item.getString("condition"),
          price: item.getInt("price"),
          kind: item.getString("kind"),
          game_key: gameKey,
          // The same text the print page's own labelLayout puts in the
          // QR today: the item's stored SKU.
          qr_text: item.getString("sku"),
        }
      : null,
  };
}

/**
 * Claim up to `limit` of the oldest queued jobs for one device.
 *
 * The whole flip happens inside one transaction that re-reads each row's
 * status first, so two devices claiming at the same moment take two
 * different batches rather than one batch twice.
 *
 * @returns {{ok:boolean, status?:number, message?:string, jobs?:object[]}}
 */
function claim(app, opts) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var options = opts || {};
  var printer = String(options.printer || "").trim();
  if (!printer) {
    return { ok: false, status: 400, message: "Say which printer is claiming these labels." };
  }
  if (printer.length > 60) {
    return { ok: false, status: 400, message: "That printer name is too long. Keep it to 60 characters or fewer." };
  }

  var limit = options.limit === undefined || options.limit === null ? DEFAULT_CLAIM_LIMIT : util.asInt(options.limit, DEFAULT_CLAIM_LIMIT);
  if (limit < 1) limit = 1;
  if (limit > MAX_CLAIM_LIMIT) limit = MAX_CLAIM_LIMIT;

  var filter = 'status = "queued"';
  var params = {};
  if (options.templateKeys && options.templateKeys.length) {
    var table = templates(app);
    var ors = [];
    for (var i = 0; i < options.templateKeys.length; i++) {
      var template = table.byKey[String(options.templateKeys[i])];
      if (!template) continue;
      var key = "t" + i;
      ors.push("template = {:" + key + "}");
      params[key] = template.id;
    }
    if (ors.length === 0) {
      return { ok: true, status: 200, jobs: [] };
    }
    filter += " && (" + ors.join(" || ") + ")";
  }

  var candidates = [];
  try {
    // A margin over the limit, so jobs another device claimed between
    // this read and the transaction below do not shorten the batch.
    candidates = app.findRecordsByFilter("label_jobs", filter, "created,id", limit * 2 + 5, 0, params);
  } catch (err) {
    candidates = [];
  }

  var claimedIds = [];
  var now = new Date().toISOString();
  app.runInTransaction(function (txApp) {
    for (var c = 0; c < candidates.length && claimedIds.length < limit; c++) {
      if (!candidates[c]) continue;
      var live = txApp.findRecordById("label_jobs", candidates[c].id);
      // Re-read inside the transaction: the row another device claimed a
      // moment ago is no longer queued and is skipped rather than taken
      // a second time.
      if (live.getString("status") !== "queued") continue;
      live.set("status", "printing");
      live.set("printer", printer);
      live.set("claimed_at", now);
      txApp.save(live);
      claimedIds.push(live.id);
    }
  });

  var jobs = [];
  for (var j = 0; j < claimedIds.length; j++) {
    try {
      jobs.push(jobShape(app, app.findRecordById("label_jobs", claimedIds[j])));
    } catch (err) {
      // A row that vanished between the claim and the read is simply not
      // handed out; the queue screen still shows it.
    }
  }
  return { ok: true, status: 200, jobs: jobs };
}

/** A `printing` (or still `queued`) job that actually came out of the printer. */
function markPrinted(app, jobId) {
  var out = null;
  var refusal = null;
  app.runInTransaction(function (txApp) {
    var live = txApp.findRecordById("label_jobs", jobId);
    var status = live.getString("status");
    if (status !== "printing" && status !== "queued") {
      refusal = {
        ok: false,
        status: 409,
        message: "That label is already " + status + ". Requeue it if it needs printing again.",
      };
      return;
    }
    live.set("status", "printed");
    live.set("printed_at", new Date().toISOString());
    live.set("error", "");
    txApp.save(live);
    out = live;
  });
  if (refusal) return refusal;
  return { ok: true, status: 200, record: out };
}

/**
 * A job the printer would not take. It goes back into the queue with the
 * reason on it until it has failed `MAX_ATTEMPTS` times, and stops there
 * rather than looping around a printer that is never going to work.
 */
function markFailed(app, jobId, error) {
  var out = null;
  var refusal = null;
  var reason = String(error || "").slice(0, 300) || "The printer refused the label";
  app.runInTransaction(function (txApp) {
    var live = txApp.findRecordById("label_jobs", jobId);
    var status = live.getString("status");
    if (status !== "printing" && status !== "queued") {
      refusal = {
        ok: false,
        status: 409,
        message: "That label is already " + status + ", so there is nothing to fail. Requeue it instead.",
      };
      return;
    }
    var attempts = live.getInt("attempts") + 1;
    live.set("attempts", attempts);
    live.set("error", reason);
    live.set("printer", "");
    live.set("claimed_at", "");
    live.set("status", attempts < MAX_ATTEMPTS ? "queued" : "failed");
    txApp.save(live);
    out = live;
  });
  if (refusal) return refusal;
  return { ok: true, status: 200, record: out };
}

/** A `failed` or `cancelled` job put back at the end of the queue, its attempts reset. */
function requeue(app, jobId) {
  var out = null;
  var refusal = null;
  app.runInTransaction(function (txApp) {
    var live = txApp.findRecordById("label_jobs", jobId);
    var status = live.getString("status");
    if (status !== "failed" && status !== "cancelled") {
      refusal = {
        ok: false,
        status: 409,
        message: "That label is " + status + ", so there is nothing to requeue.",
      };
      return;
    }
    live.set("status", "queued");
    live.set("attempts", 0);
    live.set("error", "");
    live.set("printer", "");
    live.set("claimed_at", "");
    live.set("printed_at", "");
    txApp.save(live);
    out = live;
  });
  if (refusal) return refusal;
  return { ok: true, status: 200, record: out };
}

/**
 * The `labels_unstick` cron's own work: a job still `printing` ten
 * minutes after it was claimed goes back into the queue, so a label the
 * device that claimed it never printed (a browser closed, a PC switched
 * off) is not lost. Idempotent - a requeued job carries no `claimed_at`,
 * so a second run finds nothing.
 *
 * @returns {{unstuck: number}}
 */
function unstick(app, now) {
  var at = now || new Date();
  var cutoff = pbDate(new Date(at.getTime() - STUCK_AFTER_MS));
  var rows = [];
  try {
    rows = app.findRecordsByFilter(
      "label_jobs",
      'status = "printing" && claimed_at != "" && claimed_at < {:cutoff}',
      "claimed_at",
      0,
      0,
      { cutoff: cutoff }
    );
  } catch (err) {
    rows = [];
  }

  var unstuck = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row) continue;
    try {
      app.runInTransaction(function (txApp) {
        var live = txApp.findRecordById("label_jobs", row.id);
        if (live.getString("status") !== "printing") return;
        var claimed = parseStored(live.getString("claimed_at"));
        if (!claimed || claimed.getTime() > at.getTime() - STUCK_AFTER_MS) return;
        live.set("status", "queued");
        live.set("attempts", live.getInt("attempts") + 1);
        live.set("error", "The printer stopped answering");
        live.set("printer", "");
        live.set("claimed_at", "");
        txApp.save(live);
        unstuck += 1;
      });
    } catch (err) {
      console.log("[labels] could not unstick job " + row.id + ": " + err);
    }
  }
  return { unstuck: unstuck };
}

module.exports = {
  HELD_STATUSES: HELD_STATUSES,
  MAX_BATCH: MAX_BATCH,
  MAX_COPIES: MAX_COPIES,
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  STUCK_AFTER_MS: STUCK_AFTER_MS,
  DEFAULT_CLAIM_LIMIT: DEFAULT_CLAIM_LIMIT,
  MAX_CLAIM_LIMIT: MAX_CLAIM_LIMIT,
  pbDate: pbDate,
  templateKeyFor: templateKeyFor,
  templates: templates,
  resolveItems: resolveItems,
  queue: queue,
  jobShape: jobShape,
  claim: claim,
  markPrinted: markPrinted,
  markFailed: markFailed,
  requeue: requeue,
  unstick: unstick,
};
