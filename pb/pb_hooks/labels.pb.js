/// <reference path="../pb_data/types.d.ts" />

/**
 * labels.pb.js - the bulk reprint and the cross-device print queue.
 *
 *   POST /api/vault/labels/queue          (staff)
 *   POST /api/vault/labels/claim          (staff)
 *   POST /api/vault/labels/{id}/printed   (staff)
 *   POST /api/vault/labels/{id}/failed    (staff)
 *   POST /api/vault/labels/{id}/requeue   (staff)
 *   cron labels_unstick                   (every five minutes)
 *
 * docs/api-contract.md's Phase 7 section for the shapes, lib/labels.js
 * for the logic. The queue screen itself still lists `label_jobs`
 * straight through the collection API (`expand=item,template`), and the
 * print page still marks a row printed there; these routes are what a
 * reprint of last Tuesday's intake, and two counters printing at once,
 * need on top of that.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/labels/queue   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/labels/queue",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const labels = require(`${__hooks}/lib/labels.js`);

    const staff = e.auth;
    const body = util.body(e);

    const ids = [];
    if (body.items && body.items.length) {
      for (let i = 0; i < body.items.length; i++) {
        const id = util.asStr(body.items[i]);
        if (id) ids.push(id);
      }
    }

    const selector = {
      items: ids,
      tradeIn: util.asStr(body.trade_in),
      acquiredFrom: util.asStr(body.acquired_from),
      acquiredTo: util.asStr(body.acquired_to),
      location: util.asStr(body.location),
      kind: util.asStr(body.kind),
      game: util.asStr(body.game),
    };

    // Which selectors were used and how many ids, never the ids
    // themselves in full - audit meta stays to counts and identifiers.
    const summary = {};
    if (ids.length) summary.items = ids.length;
    if (selector.tradeIn) summary.trade_in = selector.tradeIn;
    if (selector.acquiredFrom) summary.acquired_from = selector.acquiredFrom;
    if (selector.acquiredTo) summary.acquired_to = selector.acquiredTo;
    if (selector.location) summary.location = selector.location;
    if (selector.kind) summary.kind = selector.kind;
    if (selector.game) summary.game = selector.game;

    const result = labels.queue(e.app, {
      selector: selector,
      selectorSummary: summary,
      templateKey: util.asStr(body.template),
      copies: body.copies,
      includeQueued: util.asBool(body.include_queued),
      staffId: staff.id,
      ip: e.realIP(),
    });
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { queued: result.queued, skipped: result.skipped, job_ids: result.jobIds });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/labels/claim   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/labels/claim",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const labels = require(`${__hooks}/lib/labels.js`);

    const body = util.body(e);
    const templateKeys = [];
    if (body.templates && body.templates.length) {
      for (let i = 0; i < body.templates.length; i++) {
        const key = util.asStr(body.templates[i]);
        if (key) templateKeys.push(key);
      }
    }

    const result = labels.claim(e.app, {
      printer: util.asStr(body.printer),
      limit: body.limit,
      templateKeys: templateKeys,
    });
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { jobs: result.jobs });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/labels/{id}/printed   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/labels/{id}/printed",
  (e) => {
    const labels = require(`${__hooks}/lib/labels.js`);

    const jobId = e.request.pathValue("id");
    try {
      e.app.findRecordById("label_jobs", jobId);
    } catch (err) {
      throw e.notFoundError("That label job was not found. Refresh the queue.", null);
    }

    const result = labels.markPrinted(e.app, jobId);
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { job: labels.jobShape(e.app, result.record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/labels/{id}/failed   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/labels/{id}/failed",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const labels = require(`${__hooks}/lib/labels.js`);

    const jobId = e.request.pathValue("id");
    try {
      e.app.findRecordById("label_jobs", jobId);
    } catch (err) {
      throw e.notFoundError("That label job was not found. Refresh the queue.", null);
    }

    const result = labels.markFailed(e.app, jobId, util.asStr(util.body(e).error));
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { job: labels.jobShape(e.app, result.record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/labels/{id}/requeue   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/labels/{id}/requeue",
  (e) => {
    const labels = require(`${__hooks}/lib/labels.js`);

    const jobId = e.request.pathValue("id");
    try {
      e.app.findRecordById("label_jobs", jobId);
    } catch (err) {
      throw e.notFoundError("That label job was not found. Refresh the queue.", null);
    }

    const result = labels.requeue(e.app, jobId);
    if (!result.ok) {
      throw e.error(result.status, result.message, null);
    }

    return e.json(200, { job: labels.jobShape(e.app, result.record) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// cron labels_unstick, every five minutes
//
// A job a device claimed and never finished (a browser closed, a PC
// switched off mid-print) goes back into the queue after ten minutes with
// the reason on it, so the next device to claim picks it up.
// ---------------------------------------------------------------------
cronAdd("labels_unstick", "*/5 * * * *", () => {
  const labels = require(`${__hooks}/lib/labels.js`);
  try {
    const result = labels.unstick($app, new Date());
    if (result.unstuck > 0) {
      console.log(`[cron:labels_unstick] put ${result.unstuck} stuck label job(s) back in the queue`);
    }
  } catch (err) {
    console.log(`[cron:labels_unstick] failed: ${err}`);
  }
});
