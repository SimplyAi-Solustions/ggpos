/// <reference path="../pb_data/types.d.ts" />

/**
 * printing.pb.js - the counter's receipt printers, print jobs and cash drawer.
 *
 *   POST   /api/vault/printers                    (admin)  add; the URL is returned once
 *   PATCH  /api/vault/printers/{id}               (admin)
 *   POST   /api/vault/printers/{id}/rotate        (admin)  a new URL, the old one stops
 *   DELETE /api/vault/printers/{id}               (admin)
 *   GET    /api/vault/printers                    (staff)
 *   POST   /api/vault/print/jobs                  (staff)  multipart PNG or JSON text
 *   POST   /api/vault/print/drawer                (staff)  open the drawer, no paper
 *   GET    /api/vault/print/jobs                  (staff)
 *   POST   /api/vault/print/jobs/{id}/retry       (staff)
 *   POST   /api/vault/cloudprnt/{token}           (printer) the poll
 *   GET    /api/vault/cloudprnt/{token}           (printer) the job, or a delete
 *   DELETE /api/vault/cloudprnt/{token}           (printer) the job is finished
 *
 * docs/api-contract-epos.md, section 6. The protocol notes, the job life
 * cycle and the reasons for the choices below are in the header of
 * lib/printing.js, which is where to look first.
 *
 * The three CloudPRNT routes carry no PocketBase auth: the printer cannot
 * sign in, so its secret is the 32 character token in the path, and a token
 * or MAC that matches nothing is a bare 404 with no body, so a caller
 * guessing learns nothing. The migration 1789820870 rate limits the prefix.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/printers
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/printers",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    const staff = util.requireAdmin(e);
    const body = util.body(e);

    const name = util.asStr(body.name);
    if (!name) {
      throw e.badRequestError("Give the printer a name, for example Counter printer.", null);
    }
    if (name.length > 60) {
      throw e.badRequestError("Keep the printer name to 60 characters or fewer.", null);
    }
    const mac = printing.normaliseMac(body.mac);
    if (!mac) {
      throw e.badRequestError("Type the printer's MAC address, for example 00:11:e5:06:04:ff.", null);
    }
    const asked = body.paper_width;
    const paper = asked === undefined || asked === null || asked === "" ? 80 : util.asInt(asked, 0);
    if (printing.PAPER_WIDTHS.indexOf(paper) < 0) {
      throw e.badRequestError("Paper width is 80 or 58 millimetres.", null);
    }
    const model = util.asStr(body.model);
    if (model.length > 60) {
      throw e.badRequestError("Keep the model to 60 characters or fewer.", null);
    }
    const resolved = registers.resolve(e.app, util.asStr(body.register));
    if (!resolved.register) throw e.error(resolved.status, resolved.message, null);

    const TAKEN = "A printer with that MAC address is already set up. Edit that one, or remove it first.";
    if (printing.macTaken(e.app, mac, "")) throw e.error(409, TAKEN, null);

    const token = printing.newToken();
    const record = new Record(e.app.findCollectionByNameOrId("printers"), {
      name: name,
      model: model,
      mac: mac,
      token_hash: printing.hashToken(token),
      register: resolved.register.id,
      paper_width: paper,
      active: true,
    });
    try {
      e.app.save(record);
    } catch (err) {
      // Two admins adding the same printer at once collide on the index.
      if (/unique/i.test(String((err && err.message) || err))) throw e.error(409, TAKEN, null);
      throw err;
    }

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "printer_added",
      collection: "printers",
      record: record.id,
      meta: { name: name, mac: mac, register: resolved.register.id, paper_width: paper },
      ip: e.realIP(),
    });

    return e.json(201, {
      printer: printing.shapePrinter(record, printing.registerNames(e.app)),
      url: printing.printerUrl(e.app, token),
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// PATCH /api/vault/printers/{id}
// ---------------------------------------------------------------------
routerAdd(
  "PATCH",
  "/api/vault/printers/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    const staff = util.requireAdmin(e);
    const body = util.body(e);

    let printer = null;
    try {
      printer = e.app.findRecordById("printers", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That printer was not found.", null);
    }

    const changed = [];
    if (body.name !== undefined) {
      const name = util.asStr(body.name);
      if (!name) throw e.badRequestError("Give the printer a name, for example Counter printer.", null);
      if (name.length > 60) {
        throw e.badRequestError("Keep the printer name to 60 characters or fewer.", null);
      }
      if (name !== printer.getString("name")) {
        printer.set("name", name);
        changed.push("name");
      }
    }
    if (body.model !== undefined) {
      const model = util.asStr(body.model);
      if (model.length > 60) throw e.badRequestError("Keep the model to 60 characters or fewer.", null);
      if (model !== printer.getString("model")) {
        printer.set("model", model);
        changed.push("model");
      }
    }
    if (body.mac !== undefined) {
      const mac = printing.normaliseMac(body.mac);
      if (!mac) {
        throw e.badRequestError("Type the printer's MAC address, for example 00:11:e5:06:04:ff.", null);
      }
      if (mac !== printer.getString("mac")) {
        if (printing.macTaken(e.app, mac, printer.id)) {
          throw e.error(409, "A printer with that MAC address is already set up. Edit that one, or remove it first.", null);
        }
        printer.set("mac", mac);
        // A different printer: ask it for its encodings again.
        printer.set("encodings", null);
        changed.push("mac");
      }
    }
    if (body.register !== undefined) {
      const resolved = registers.resolve(e.app, util.asStr(body.register));
      if (!resolved.register) throw e.error(resolved.status, resolved.message, null);
      if (resolved.register.id !== printer.getString("register")) {
        printer.set("register", resolved.register.id);
        changed.push("register");
      }
    }
    if (body.paper_width !== undefined) {
      const paper = util.asInt(body.paper_width, 0);
      if (printing.PAPER_WIDTHS.indexOf(paper) < 0) {
        throw e.badRequestError("Paper width is 80 or 58 millimetres.", null);
      }
      if (paper !== printer.getInt("paper_width")) {
        printer.set("paper_width", paper);
        changed.push("paper_width");
      }
    }
    if (body.active !== undefined) {
      const active = util.asBool(body.active);
      if (active !== printer.getBool("active")) {
        printer.set("active", active);
        changed.push("active");
      }
    }

    if (changed.length > 0) {
      e.app.save(printer);
      auditLib.writeAuditLog(e.app, {
        actor: staff.id,
        action: "printer_updated",
        collection: "printers",
        record: printer.id,
        meta: { fields: changed, name: printer.getString("name") },
        ip: e.realIP(),
      });
    }

    return e.json(200, { printer: printing.shapePrinter(printer, printing.registerNames(e.app)) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/printers/{id}/rotate
//
// A new token, so the URL in the printer stops working at once and the new
// one is shown once. The printer prints nothing until somebody types the
// new URL into it, which is what the Settings screen says before it asks.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/printers/{id}/rotate",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    const staff = util.requireAdmin(e);

    let printer = null;
    try {
      printer = e.app.findRecordById("printers", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That printer was not found.", null);
    }

    const token = printing.newToken();
    printer.set("token_hash", printing.hashToken(token));
    e.app.save(printer);

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "printer_rotated",
      collection: "printers",
      record: printer.id,
      meta: { name: printer.getString("name") },
      ip: e.realIP(),
    });

    return e.json(200, {
      printer: printing.shapePrinter(printer, printing.registerNames(e.app)),
      url: printing.printerUrl(e.app, token),
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// DELETE /api/vault/printers/{id}
//
// Its jobs go with it (print_jobs.printer cascades), files included.
// ---------------------------------------------------------------------
routerAdd(
  "DELETE",
  "/api/vault/printers/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);

    let printer = null;
    try {
      printer = e.app.findRecordById("printers", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That printer was not found.", null);
    }
    const meta = { name: printer.getString("name"), mac: printer.getString("mac") };
    const id = printer.id;
    e.app.delete(printer);

    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "printer_removed",
      collection: "printers",
      record: id,
      meta: meta,
      ip: e.realIP(),
    });

    return e.noContent(204);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/printers
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/printers",
  (e) => {
    const printing = require(`${__hooks}/lib/printing.js`);

    const names = printing.registerNames(e.app);
    const now = new Date();
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter("printers", "id != ''", "name,created", 0, 0);
    } catch (err) {
      rows = [];
    }
    const printers = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) printers.push(printing.shapePrinter(rows[i], names, now));
    }
    return e.json(200, { printers: printers });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/print/jobs
//
// Multipart with a PNG `file`, or JSON with `text`. The PNG must be exactly
// as wide as the printer's paper, because the printer prints it pixel for
// pixel with no scaling: a receipt drawn at the wrong width would come out
// cut off or tiny, so it is refused here with the width that was wanted.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/print/jobs",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    const body = util.body(e);

    /** A field from the parsed body, or straight off the multipart form. */
    function field(name) {
      const fromBody = body[name];
      if (fromBody !== undefined && fromBody !== null && fromBody !== "") return util.asStr(fromBody);
      try {
        return util.asStr(e.request.formValue(name));
      } catch (err) {
        return "";
      }
    }

    const kind = field("kind");
    if (printing.KINDS.indexOf(kind) < 0) {
      throw e.badRequestError("Say what is being printed: a receipt, a gift receipt, a refund receipt, an X or Z report or a test.", null);
    }
    const copies = field("copies") === "" ? 1 : util.asInt(field("copies"), 0);
    if (copies < 1 || copies > printing.MAX_COPIES) {
      throw e.badRequestError("Print between 1 and " + printing.MAX_COPIES + " copies.", null);
    }
    const drawer = util.asBool(field("drawer"));
    const cutText = field("cut");
    const cut = cutText === "" ? true : util.asBool(cutText);
    const ref = field("ref");
    if (ref.length > 40) throw e.badRequestError("The reference is too long to store.", null);

    // Which printer: the one named, or the register's own.
    let printer = null;
    const printerId = field("printer");
    if (printerId) {
      try {
        printer = e.app.findRecordById("printers", printerId);
      } catch (err) {
        throw e.notFoundError("That printer was not found.", null);
      }
      if (!printer.getBool("active")) {
        throw e.error(409, "That printer is switched off. Switch it on under Settings, Printers first.", null);
      }
    } else {
      const resolved = registers.resolve(e.app, field("register"));
      if (!resolved.register) throw e.error(resolved.status, resolved.message, null);
      printer = printing.printerForRegister(e.app, resolved.register.id);
      if (!printer) {
        throw e.error(409, printing.noPrinterMessage(resolved.register.getString("name")), null);
      }
    }

    // What: a PNG, or text.
    let uploads = [];
    try {
      uploads = e.findUploadedFiles("file") || [];
    } catch (err) {
      uploads = [];
    }
    const text = field("text");
    let format = "";
    let bytes = null;

    if (uploads.length > 0 && uploads[0]) {
      const upload = uploads[0];
      const TOO_BIG = "That image is over 2 MB. Draw the receipt again at the printer's width.";
      if (upload.size > printing.MAX_PNG_BYTES) throw e.badRequestError(TOO_BIG, null);
      let reader = null;
      try {
        reader = upload.reader.open();
        // One byte past the cap, so an upload that lies about its size is
        // still refused rather than pulled into memory whole.
        bytes = toBytes(reader, printing.MAX_PNG_BYTES + 1);
      } catch (err) {
        throw e.badRequestError("That image could not be read. Draw the receipt again.", null);
      } finally {
        if (reader) {
          try {
            reader.close();
          } catch (err) {
            // Nothing useful to do if the reader will not close.
          }
        }
      }
      if (bytes.length > printing.MAX_PNG_BYTES) throw e.badRequestError(TOO_BIG, null);

      const size = printing.pngSize(bytes);
      if (!size) {
        throw e.badRequestError("That file is not a PNG image. Draw the receipt again.", null);
      }
      const wanted = printing.pixelWidth(printer);
      if (size.width !== wanted) {
        throw e.badRequestError(
          "That image is " + size.width + " pixels wide but " + printer.getString("name") + " prints " + wanted + " across. Draw the receipt again at " + wanted + ".",
          null
        );
      }
      if (size.height < 1 || size.height > printing.MAX_PNG_HEIGHT) {
        throw e.badRequestError("That image is too tall to print. Keep a receipt under " + printing.MAX_PNG_HEIGHT + " pixels.", null);
      }
      format = "image/png";
    } else if (text) {
      if (text.length > printing.MAX_TEXT) {
        throw e.badRequestError("That text is too long to print. Keep it under " + printing.MAX_TEXT + " characters.", null);
      }
      format = "text/plain";
    } else {
      throw e.badRequestError("Add the receipt image or the text to print.", null);
    }

    let first = null;
    for (let i = 0; i < copies; i++) {
      const job = printing.queueJob(e.app, {
        printer: printer,
        kind: kind,
        ref: ref,
        format: format,
        bytes: bytes,
        text: format === "text/plain" ? text : "",
        // One copy opens the drawer, not three.
        drawer: drawer && i === 0,
        cut: cut,
        staff: e.auth.id,
      });
      if (!first) first = job;
    }

    return e.json(201, { job: printing.shapeJob(first) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/print/drawer
//
// The drawer with no paper. Used by the counter after a cash sale with no
// receipt; the till routes (no sale, paid in and out) call the same
// lib/printing.js function themselves.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/print/drawer",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const registers = require(`${__hooks}/lib/registers.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    const body = util.body(e);
    const resolved = registers.resolve(e.app, util.asStr(body.register));
    if (!resolved.register) throw e.error(resolved.status, resolved.message, null);

    const job = printing.queueDrawerKick(e.app, {
      register: resolved.register.id,
      staff: e.auth.id,
      ref: util.asStr(body.ref),
    });
    if (!job) {
      throw e.error(409, printing.noPrinterMessage(resolved.register.getString("name")), null);
    }
    return e.json(201, { job: printing.shapeJob(job) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/print/jobs?register=&status=&page=&per_page=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/print/jobs",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const printing = require(`${__hooks}/lib/printing.js`);

    /** A query parameter, trimmed. */
    function query(name) {
      return util.asStr(e.request.url.query().get(name));
    }

    const register = query("register");
    const status = query("status");
    if (status && ["queued", "printing", "done", "failed", "cancelled"].indexOf(status) < 0) {
      throw e.badRequestError("Status is queued, printing, done, failed or cancelled.", null);
    }
    let page = util.asInt(query("page"), 1);
    if (page < 1) page = 1;
    let perPage = util.asInt(query("per_page"), 25);
    if (perPage < 1) perPage = 25;
    if (perPage > 100) perPage = 100;

    const filters = [];
    const sql = [];
    const params = {};
    if (register) {
      filters.push("register = {:register}");
      sql.push("register = {:register}");
      params.register = register;
    }
    if (status) {
      filters.push("status = {:status}");
      sql.push("status = {:status}");
      params.status = status;
    }

    const total = sql.length
      ? e.app.countRecords("print_jobs", $dbx.exp(sql.join(" AND "), params))
      : e.app.countRecords("print_jobs");
    let rows = [];
    try {
      rows = e.app.findRecordsByFilter(
        "print_jobs",
        filters.length ? filters.join(" && ") : "id != ''",
        "-created,id",
        perPage,
        (page - 1) * perPage,
        params
      );
    } catch (err) {
      rows = [];
    }
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) items.push(printing.shapeJob(rows[i]));
    }
    return e.json(200, { items: items, page: page, per_page: perPage, total: total });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/print/jobs/{id}/retry
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/print/jobs/{id}/retry",
  (e) => {
    const printing = require(`${__hooks}/lib/printing.js`);

    let job = null;
    try {
      job = e.app.findRecordById("print_jobs", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("That print job was not found.", null);
    }
    const status = job.getString("status");
    if (status === "done") {
      throw e.error(409, "That job already printed. Print the receipt again from the sale.", null);
    }
    if (status === "queued" || status === "printing") {
      throw e.error(409, "That job is still waiting for the printer.", null);
    }
    // A failed image with its file cleared cannot be sent again.
    if (job.getString("format") === "image/png" && job.getString("kind") !== "drawer" && !job.getString("file")) {
      throw e.error(409, "That job's image has been cleared. Print the receipt again from the sale.", null);
    }
    e.app.runInTransaction((txApp) => {
      const live = txApp.findRecordById("print_jobs", job.id);
      live.set("status", "queued");
      live.set("attempts", 0);
      live.set("error", "");
      live.set("claimed_at", "");
      txApp.save(live);
      job = live;
    });
    return e.json(200, { job: printing.shapeJob(job) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/cloudprnt/{token}   (the printer's poll)
// ---------------------------------------------------------------------
routerAdd("POST", "/api/vault/cloudprnt/{token}", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const printing = require(`${__hooks}/lib/printing.js`);

  let body = util.body(e);
  if (!body || body.printerMAC === undefined) {
    // The poll is JSON, but a firmware that sends it under another
    // Content-Type would otherwise never be heard: read the raw body.
    try {
      const parsed = JSON.parse(toString(e.request.body));
      if (parsed && typeof parsed === "object") body = parsed;
    } catch (err) {
      body = body || {};
    }
  }

  const printer = printing.authenticate(e.app, e.request.pathValue("token"), body.printerMAC, true);
  if (!printer) return e.noContent(404);

  try {
    printing.recordPoll(e.app, printer, body);
  } catch (err) {
    // The answer matters more than the bookkeeping: carry on.
    console.log(`[printing] could not record a poll for printer ${printer.id}: ${err}`);
  }
  return e.json(200, printing.pollAnswer(e.app, printer));
});

// ---------------------------------------------------------------------
// GET /api/vault/cloudprnt/{token}?uid=&type=&mac=   (the job)
// GET /api/vault/cloudprnt/{token}?uid=&mac=&code=OK&delete
//   (the finished-job report, for a printer told deleteMethod is GET)
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/cloudprnt/{token}", (e) => {
  const printing = require(`${__hooks}/lib/printing.js`);

  const query = e.request.url.query();
  const printer = printing.authenticate(e.app, e.request.pathValue("token"), query.get("mac"), false);
  if (!printer) return e.noContent(404);

  if (query.has("delete")) {
    printing.settle(e.app, printer, query.get("code"));
    return e.noContent(200);
  }

  const served = printing.serveNext(e.app, printer, query.get("type"));
  if (served.status !== 200) return e.noContent(served.status);

  const header = e.response.header();
  header.set("Cache-Control", "no-store");
  for (const name in served.headers) header.set(name, served.headers[name]);
  return e.blob(200, served.contentType, served.bytes);
});

// ---------------------------------------------------------------------
// DELETE /api/vault/cloudprnt/{token}?uid=&mac=&code=OK   (the job is done)
// ---------------------------------------------------------------------
routerAdd("DELETE", "/api/vault/cloudprnt/{token}", (e) => {
  const printing = require(`${__hooks}/lib/printing.js`);

  const query = e.request.url.query();
  const printer = printing.authenticate(e.app, e.request.pathValue("token"), query.get("mac"), false);
  if (!printer) return e.noContent(404);

  printing.settle(e.app, printer, query.get("code"));
  return e.noContent(200);
});

// ---------------------------------------------------------------------
// print_jobs_tidy, every five minutes: a job `printing` for over two
// minutes goes back to `queued` (or `failed` on its third try), and the
// PNG of a job done more than seven days ago is deleted.
// ---------------------------------------------------------------------
cronAdd("print_jobs_tidy", "*/5 * * * *", () => {
  const printing = require(`${__hooks}/lib/printing.js`);
  try {
    const result = printing.tidy($app, new Date());
    if (result.requeued + result.failed + result.cleared > 0) {
      console.log(
        `[cron:print_jobs_tidy] requeued ${result.requeued}, failed ${result.failed}, cleared ${result.cleared} file(s)`
      );
    }
  } catch (err) {
    console.log(`[cron:print_jobs_tidy] failed: ${err}`);
  }
});
