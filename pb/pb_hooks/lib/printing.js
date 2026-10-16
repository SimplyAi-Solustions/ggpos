/**
 * lib/printing.js - the shop's receipt printers, their print jobs and the
 * cash drawer (docs/api-contract-epos.md, section 6), behind printing.pb.js.
 *
 * The Mac and the Android tablet never talk to the printer. They draw the
 * receipt in the browser, post the PNG here, and the printer (a Star
 * TSP143IV LAN or an mC-Print3 on the counter's network, with the cash
 * drawer plugged into it) collects the job from this server on its own.
 * That is Star CloudPRNT, and everything below is in service of it.
 *
 * ---------------------------------------------------------------------
 * CloudPRNT in brief (Star CloudPRNT Developer Guide, HI01X / HI02X, 1.4)
 * ---------------------------------------------------------------------
 *
 * The printer is the client. It is given one URL in its web settings
 * (CloudPRNT, Server URL, polling time 2 seconds) and does three things:
 *
 *   POST <url>             the poll. JSON body:
 *     { "status": "<ASB hex>", "printerMAC": "00:11:e5:06:04:ff",
 *       "uniqueID": "...", "statusCode": "200%20OK",
 *       "printingInProgress": false,
 *       "clientAction": [ { "request": "Encodings", "result": "..." } ] | null }
 *     Every field but statusCode is optional. statusCode is URL-encoded and
 *     starts with 2 when the printer is healthy. The answer is JSON:
 *     { "jobReady": true, "mediaTypes": ["image/png"] } or
 *     { "jobReady": false }, and it may carry a "clientAction" list. A
 *     client action and a job are never in the same answer: the printer
 *     handles the actions and does not print on that round.
 *     The "Encodings" action asks the printer which media types it can
 *     print; it answers in the next poll's clientAction[].result, for
 *     example "image/png; image/jpeg; application/vnd.star.line; text/plain".
 *
 *   GET <url>?uid=&type=<media type>&mac=<mac>
 *     fetches the job. The body is the job in the requested type with that
 *     Content-Type: 200, or 404 when there is nothing, 415 when the type is
 *     not one the job is in. For text/plain, image/png and image/jpeg the
 *     server can steer the printer with headers (firmware 1.3 and later):
 *       X-Star-CashDrawer: none | start | end      open the drawer
 *       X-Star-Cut: full | partial | none; feed=true|false
 *       X-Star-ImageDitherPattern: none | fs       "none" for images that
 *                                                  are already one bit
 *     The GET has no side effects on the printer's side and it may fetch
 *     the same job again.
 *
 *   DELETE <url>?uid=&mac=&code=OK
 *     the printer saying it has finished. code=OK means printed; anything
 *     else is the printer's own status code for what went wrong. If the
 *     poll answer set deleteMethod to GET, the printer sends GET with a
 *     "delete" query parameter instead of DELETE. This server accepts both.
 *
 * Images are printed pixel for pixel with no scaling: 576 px wide on 80 mm
 * paper, 384 px on 58 mm, which is why POST /api/vault/print/jobs checks the
 * PNG's width against the printer's paper before it queues anything.
 *
 * Auth. The printer can do HTTP Basic, but it identifies itself by MAC
 * address (always the Ethernet MAC, even on Wi-Fi), which is printed on its
 * label and is no secret. The secret is 32 random characters in the URL
 * PATH, not the query, because the printer appends its own ?uid=&type=&mac=
 * query string to whatever it is given. Only the sha256 of that token is
 * stored (printers.token_hash); the URL is shown once, when the printer is
 * added or its URL is rotated. A token that matches nobody, or a MAC that is
 * not the printer's own, is a bare 404 with no body.
 *
 * ---------------------------------------------------------------------
 * How a job moves
 * ---------------------------------------------------------------------
 *
 *   queued   -- the printer's GET -->  printing  (attempts + 1, claimed_at)
 *   printing -- DELETE code=OK    -->  done      (printed_at)
 *   printing -- DELETE code=other -->  queued    (error = the code), or
 *                                      failed once attempts reaches 3
 *   printing for over two minutes --> queued, or failed on the third go
 *                                      (the print_jobs_tidy cron)
 *
 * attempts is counted when the printer takes the job, not when it reports
 * back, so a printer that goes quiet halfway through still uses up a try and
 * a job can never cycle round forever. A second GET of a job that is already
 * printing is the printer retrying the same fetch and counts for nothing.
 *
 * Three formats are stored in print_jobs.format:
 *   image/png                  the receipt or report the browser drew
 *                              (print_jobs.file, a protected file field), or,
 *                              for a drawer kick on a printer that did not
 *                              list star.line, a one-pixel white PNG built
 *                              here at the printer's width
 *   text/plain                 print_jobs.text
 *   application/vnd.star.line  Star Line Mode. Only ever the drawer kick:
 *                              one BEL (0x07), "drive external device 1",
 *                              which is the cash drawer on the RJ12 port.
 *                              The byte is built when the job is served, so
 *                              the row holds no body.
 *
 * Which of the last two a drawer kick uses is decided when it is queued,
 * from the printer's `encodings` (the answer to the Encodings action,
 * stored as a lower-case array of media types). A printer that has not
 * answered yet gets the PNG, which every CloudPRNT printer takes.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

var MAX_ATTEMPTS = 3;
var ONLINE_WITHIN_MS = 30 * 1000;
var STUCK_AFTER_MS = 2 * 60 * 1000;
var KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1000;
var MAX_PNG_BYTES = 2 * 1024 * 1024;
// 16384 dots at 8 dots a millimetre is two metres of paper: a mistake.
var MAX_PNG_HEIGHT = 16384;
var MAX_TEXT = 20000;
var MAX_COPIES = 3;
var TOKEN_LENGTH = 32;
var STAR_LINE = "application/vnd.star.line";
var KINDS = ["receipt", "gift_receipt", "refund_receipt", "x_report", "z_report", "drawer", "test"];
var PAPER_WIDTHS = [80, 58];

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

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

/** A stored date as strict ISO 8601, or "" when there is none. */
function toIso(value) {
  var d = parseStored(value);
  return d ? d.toISOString() : "";
}

// ---------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------

/** The sha256 of a printer's URL token. Only this is ever stored. */
function hashToken(token) {
  return $security.sha256(String(token || ""));
}

/** A fresh URL token: 32 random letters and digits, around 190 bits. */
function newToken() {
  return $security.randomString(TOKEN_LENGTH);
}

/** The printer behind a URL token, or null. Never says why it found nobody. */
function findByToken(app, token) {
  var raw = String(token || "");
  // A cheap shape check first, so garbage never reaches the database.
  if (!/^[A-Za-z0-9]{32}$/.test(raw)) return null;
  try {
    return app.findFirstRecordByFilter("printers", "token_hash = {:h}", { h: hashToken(raw) });
  } catch (err) {
    return null;
  }
}

/**
 * A MAC address in the one stored form, aa:bb:cc:dd:ee:ff, or "" when the
 * input is not one. Accepts colons, hyphens or nothing between the pairs.
 */
function normaliseMac(raw) {
  var s = String(raw === null || raw === undefined ? "" : raw).trim().toLowerCase();
  if (!/^([0-9a-f]{2}[:\-]?){5}[0-9a-f]{2}$/.test(s)) return "";
  var hex = s.replace(/[:\-]/g, "");
  var pairs = [];
  for (var i = 0; i < 12; i += 2) pairs.push(hex.substr(i, 2));
  return pairs.join(":");
}

/** The width in dots a printer prints across: 576 on 80 mm paper, 384 on 58 mm. */
function pixelWidth(printer) {
  return printer.getInt("paper_width") === 58 ? 384 : 576;
}

/**
 * The URL to type into the printer. The app's public address comes from
 * PocketBase's own settings (the bootstrap sets it), so the same code gives
 * the right URL on the shop's server and on a developer's machine.
 */
function printerUrl(app, token) {
  var base = "";
  try {
    base = app.settings().meta.appURL || "";
  } catch (err) {
    base = "";
  }
  return String(base).replace(/\/+$/, "") + "/api/vault/cloudprnt/" + token;
}

/**
 * The printer behind a CloudPRNT request, or null, which the route answers
 * with a bare 404. The URL token must match a printer; the MAC the printer
 * names must be its own. The poll always names one (`mustNameMac`); a GET or
 * DELETE that names none is let through on the strength of the token, and
 * one that names a different MAC is not.
 */
function authenticate(app, token, claimedMac, mustNameMac) {
  var printer = findByToken(app, token);
  if (!printer) return null;
  var claimed = claimedMac === null || claimedMac === undefined || claimedMac === "" ? "" : normaliseMac(claimedMac);
  var named = claimedMac !== null && claimedMac !== undefined && claimedMac !== "";
  if (!named) return mustNameMac ? null : printer;
  return claimed && claimed === printer.getString("mac") ? printer : null;
}

/** True when another printer already has this MAC address. */
function macTaken(app, mac, exceptId) {
  try {
    app.findFirstRecordByFilter("printers", "mac = {:m} && id != {:id}", { m: mac, id: exceptId || "" });
    return true;
  } catch (err) {
    return false;
  }
}

/** The media types a printer said it can print, lower-case, or []. */
function encodingsOf(printer) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var list = util.jsonField(printer, "encodings", []);
  return Array.isArray(list) ? list : [];
}

/** True when the printer listed this media type in its Encodings answer. */
function supports(printer, mediaType) {
  return encodingsOf(printer).indexOf(String(mediaType).toLowerCase()) >= 0;
}

/** True when the printer polled within the last 30 seconds. */
function isOnline(printer, now) {
  var last = parseStored(printer.getString("last_poll_at"));
  if (!last) return false;
  return (now || new Date()).getTime() - last.getTime() < ONLINE_WITHIN_MS;
}

/** register id -> register name, for the list and the messages. */
function registerNames(app) {
  var names = {};
  var rows = [];
  try {
    rows = app.findRecordsByFilter("registers", "id != ''", "sort,created", 0, 0);
  } catch (err) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) names[rows[i].id] = rows[i].getString("name");
  }
  return names;
}

/** One printer as every route returns it. Never the token or its hash. */
function shapePrinter(printer, names, now) {
  var register = printer.getString("register");
  return {
    id: printer.id,
    name: printer.getString("name"),
    model: printer.getString("model"),
    mac: printer.getString("mac"),
    register: register,
    register_name: (names && names[register]) || "",
    paper_width: printer.getInt("paper_width"),
    active: printer.getBool("active"),
    last_poll_at: toIso(printer.getString("last_poll_at")),
    last_status: printer.getString("last_status"),
    online: isOnline(printer, now),
  };
}

/** One job as every route returns it. Never the file or the text. */
function shapeJob(job) {
  return {
    id: job.id,
    printer: job.getString("printer"),
    register: job.getString("register"),
    kind: job.getString("kind"),
    ref: job.getString("ref"),
    status: job.getString("status"),
    attempts: job.getInt("attempts"),
    error: job.getString("error"),
    created: toIso(job.getString("created")),
    printed_at: toIso(job.getString("printed_at")),
  };
}

/**
 * The active printer that serves a register, or null. With more than one,
 * the one that polled most recently wins: the one that is actually there.
 */
function printerForRegister(app, registerId) {
  var id = registerId ? String(registerId) : "";
  if (!id) return null;
  try {
    var rows = app.findRecordsByFilter(
      "printers",
      "register = {:r} && active = true",
      "-last_poll_at,created",
      1,
      0,
      { r: id }
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/** The refusal sentence for a register that has no printer to print on. */
function noPrinterMessage(registerName) {
  return "No receipt printer is set up for " + (registerName || "this register") + ". Add one under Settings, Printers.";
}

// ---------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------

/** A record, or an id string, as an id string. */
function idOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id ? String(value.id) : "";
}

/**
 * Queue a print job on a printer.
 *
 * @param {any} app - $app, or a txApp when the caller is inside a transaction.
 * @param {{printer: any, register?: string, kind: string, ref?: string, format: string,
 *   bytes?: number[]|null, text?: string, drawer?: boolean, cut?: boolean, staff?: string}} opts
 * @returns the print_jobs record
 */
function queueJob(app, opts) {
  var o = opts || {};
  var record = new Record(app.findCollectionByNameOrId("print_jobs"), {
    printer: o.printer.id,
    register: o.register || o.printer.getString("register"),
    kind: o.kind,
    ref: String(o.ref || "").slice(0, 40),
    format: o.format,
    text: o.text || "",
    drawer: o.drawer === true,
    cut: o.cut !== false,
    status: "queued",
    attempts: 0,
    error: "",
    created_by: idOf(o.staff),
  });
  if (o.bytes && o.bytes.length) {
    record.set("file", $filesystem.fileFromBytes(o.bytes, "job-" + $security.randomString(10) + ".png"));
  }
  app.save(record);
  return record;
}

/**
 * Queue a drawer kick on the register's active printer: no paper, just the
 * drawer. The till package calls this after its own transaction (a cash
 * sale with no receipt, no sale, paid in and out), and so does
 * POST /api/vault/print/drawer.
 *
 * Returns the print_jobs record, or null when the register has no active
 * printer, which is the caller's cue to say the drawer key is the way in.
 * With no register given it is the default register's printer.
 *
 * @param {any} app
 * @param {{register?: string|any, staff?: string|any, ref?: string}} opts
 */
function queueDrawerKick(app, opts) {
  var o = opts || {};
  var registers = require(__hooks + "/lib/registers.js");
  var registerId = idOf(o.register);
  if (!registerId) {
    var fallback = registers.defaultRegister(app);
    registerId = fallback ? fallback.id : "";
  }
  var printer = printerForRegister(app, registerId);
  if (!printer) return null;
  return queueJob(app, {
    printer: printer,
    register: registerId,
    kind: "drawer",
    ref: o.ref,
    // Star Line Mode when the printer said it takes it, otherwise the
    // one-pixel PNG every CloudPRNT printer takes.
    format: supports(printer, STAR_LINE) ? STAR_LINE : "image/png",
    drawer: true,
    cut: false,
    staff: o.staff,
  });
}

/** The oldest job the printer has yet to finish, or null. */
function oldestOpen(app, printer) {
  try {
    var rows = app.findRecordsByFilter(
      "print_jobs",
      "printer = {:p} && (status = 'queued' || status = 'printing')",
      "created,id",
      1,
      0,
      { p: printer.id }
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/** The job's PNG from the protected file field, as bytes. Null if it is gone. */
function readFileBytes(app, job) {
  var name = job.getString("file");
  if (!name) return null;
  var fsys = app.newFilesystem();
  try {
    var reader = fsys.getReader(job.baseFilesPath() + "/" + name);
    try {
      return toBytes(reader);
    } finally {
      try {
        reader.close();
      } catch (err) {
        // Nothing useful to do if the reader will not close.
      }
    }
  } catch (err) {
    return null;
  } finally {
    try {
      fsys.close();
    } catch (err) {
      // Nothing useful to do if the filesystem will not close.
    }
  }
}

/**
 * The poll's answer for a printer: a job when one is waiting, otherwise a
 * request for the printer's encodings if they are not known yet, otherwise
 * nothing. Never a job and an action together.
 */
function pollAnswer(app, printer) {
  if (printer.getBool("active")) {
    var job = oldestOpen(app, printer);
    if (job) return { jobReady: true, mediaTypes: [job.getString("format")] };
  }
  if (encodingsOf(printer).length === 0) {
    return { jobReady: false, clientAction: [{ request: "Encodings", options: "" }] };
  }
  return { jobReady: false };
}

/**
 * The media types in an Encodings answer. Star separates them with
 * semicolons ("image/png; image/jpeg; ..."); commas are tolerated.
 */
function parseEncodings(result) {
  var parts = String(result || "").split(/[;,]/);
  var seen = {};
  var list = [];
  for (var i = 0; i < parts.length && list.length < 24; i++) {
    var type = parts[i].trim().toLowerCase();
    if (!type || type.length > 80 || seen[type]) continue;
    seen[type] = true;
    list.push(type);
  }
  return list;
}

/** statusCode arrives URL-encoded ("200%20OK"). */
function decodeStatus(raw) {
  var text = String(raw === null || raw === undefined ? "" : raw);
  try {
    text = decodeURIComponent(text);
  } catch (err) {
    // Not valid percent-encoding: keep it as it came.
  }
  return text.trim().slice(0, 200);
}

/**
 * Record a poll: when it came, what the printer said about itself, and any
 * encodings it reported. One save, so the list's "online" and "last seen"
 * move together.
 */
function recordPoll(app, printer, body) {
  printer.set("last_poll_at", new Date().toISOString());
  var status = decodeStatus(body && body.statusCode);
  if (status) printer.set("last_status", status);

  var actions = body && body.clientAction;
  if (Array.isArray(actions)) {
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      if (!action || String(action.request || "").toLowerCase() !== "encodings") continue;
      var list = parseEncodings(action.result);
      if (list.length) printer.set("encodings", list);
    }
  }
  app.save(printer);
}

/**
 * Hand the printer its job. Marks the oldest open job `printing` the first
 * time it is fetched; a second fetch of the same job changes nothing.
 *
 * Returns { status: 404 } when there is nothing, { status: 415 } when the
 * printer asked for a type the job is not in, otherwise
 * { status: 200, job, contentType, bytes, headers }.
 */
function serveNext(app, printer, type) {
  var wanted = String(type || "").trim().toLowerCase();
  if (!printer.getBool("active")) return { status: 404 };

  var served = null;
  var refusal = 0;
  app.runInTransaction(function (txApp) {
    var job = oldestOpen(txApp, printer);
    if (!job) {
      refusal = 404;
      return;
    }
    var format = job.getString("format");
    if (wanted && wanted !== format) {
      refusal = 415;
      return;
    }
    if (job.getString("status") === "queued") {
      job.set("status", "printing");
      job.set("claimed_at", new Date().toISOString());
      job.set("attempts", job.getInt("attempts") + 1);
      txApp.save(job);
    }
    served = job;
  });
  if (refusal) return { status: refusal };

  var format = served.getString("format");
  var drawer = served.getBool("drawer");
  if (format === STAR_LINE) {
    // BEL: drive external device 1, the drawer. Nothing to print.
    return { status: 200, job: served, contentType: STAR_LINE, bytes: drawer ? [0x07] : [], headers: {} };
  }
  var headers = {
    "X-Star-CashDrawer": drawer ? "start" : "none",
    "X-Star-Cut": served.getBool("cut") ? "full; feed=true" : "none",
    // Drawn in the browser and already one bit: no dithering on top.
    "X-Star-ImageDitherPattern": "none",
  };
  if (format === "text/plain") {
    return { status: 200, job: served, contentType: "text/plain", bytes: served.getString("text"), headers: headers };
  }
  var bytes = readFileBytes(app, served);
  if (!bytes) {
    // A drawer kick on a printer without star.line has no file by design.
    // Anything else with no file has been cleared on its retention schedule.
    if (served.getString("kind") === "drawer") bytes = whitePng(pixelWidth(printer));
    else return { status: 404 };
  }
  return { status: 200, job: served, contentType: "image/png", bytes: bytes, headers: headers };
}

/**
 * The printer's DELETE (or GET with `delete`): code=OK is printed, anything
 * else is a failure that puts the job back until its third try.
 *
 * The request names no job. The printer works one at a time, so it is the
 * oldest one it has taken and not yet finished; a job the stuck-job pass
 * has already put back in the queue counts too, since the printer could
 * only have been working on that.
 *
 * @returns {{job: any|null}} the job that was settled, or null for a stray DELETE
 */
function settle(app, printer, code) {
  var outcome = String(code === null || code === undefined ? "" : code).trim();
  var settled = null;
  app.runInTransaction(function (txApp) {
    var rows = [];
    try {
      rows = txApp.findRecordsByFilter(
        "print_jobs",
        "printer = {:p} && (status = 'printing' || (status = 'queued' && attempts > 0))",
        // "printing" sorts before "queued", so a job in the printer's hands
        // is settled before one that was merely put back.
        "status,created,id",
        1,
        0,
        { p: printer.id }
      );
    } catch (err) {
      rows = [];
    }
    if (!rows.length) return;
    var job = rows[0];
    if (outcome.toUpperCase() === "OK") {
      job.set("status", "done");
      job.set("printed_at", new Date().toISOString());
      job.set("claimed_at", "");
      job.set("error", "");
    } else {
      // The printer's own code is the reason; it is what staff will be told.
      job.set("error", (outcome || "The printer reported a fault").slice(0, 300));
      job.set("claimed_at", "");
      job.set("status", job.getInt("attempts") >= MAX_ATTEMPTS ? "failed" : "queued");
    }
    txApp.save(job);
    settled = job;
  });
  return { job: settled };
}

/**
 * The stuck-job and retention pass behind the print_jobs_tidy cron.
 *
 *  - A job `printing` for over two minutes is put back to `queued`, or
 *    `failed` when it has already used its three tries.
 *  - The PNG of a job that finished over seven days ago is deleted (the row
 *    stays, as the record that it printed).
 *
 * @returns {{requeued: number, failed: number, cleared: number}}
 */
function tidy(app, now) {
  var at = now || new Date();
  var result = { requeued: 0, failed: 0, cleared: 0 };

  var stuck = [];
  try {
    stuck = app.findRecordsByFilter(
      "print_jobs",
      "status = 'printing' && claimed_at != '' && claimed_at < {:cutoff}",
      "claimed_at",
      0,
      0,
      { cutoff: pbDate(new Date(at.getTime() - STUCK_AFTER_MS)) }
    );
  } catch (err) {
    stuck = [];
  }
  for (var i = 0; i < stuck.length; i++) {
    var row = stuck[i];
    if (!row) continue;
    try {
      app.runInTransaction(function (txApp) {
        var live = txApp.findRecordById("print_jobs", row.id);
        if (live.getString("status") !== "printing") return;
        var claimed = parseStored(live.getString("claimed_at"));
        if (!claimed || claimed.getTime() > at.getTime() - STUCK_AFTER_MS) return;
        var failed = live.getInt("attempts") >= MAX_ATTEMPTS;
        live.set("status", failed ? "failed" : "queued");
        live.set("error", "The printer stopped answering");
        live.set("claimed_at", "");
        txApp.save(live);
        if (failed) result.failed += 1;
        else result.requeued += 1;
      });
    } catch (err) {
      console.log("[printing] could not put job " + row.id + " back: " + err);
    }
  }

  var old = [];
  try {
    old = app.findRecordsByFilter(
      "print_jobs",
      "status = 'done' && printed_at != '' && printed_at < {:cutoff} && file != ''",
      "printed_at",
      0,
      0,
      { cutoff: pbDate(new Date(at.getTime() - KEEP_FILES_MS)) }
    );
  } catch (err) {
    old = [];
  }
  for (var j = 0; j < old.length; j++) {
    var done = old[j];
    if (!done) continue;
    try {
      done.set("file", "");
      app.save(done);
      result.cleared += 1;
    } catch (err) {
      console.log("[printing] could not clear the file of job " + done.id + ": " + err);
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// PNG
//
// Pure byte work, no PocketBase: the checks load this file in plain Node
// to prove the PNG it builds decodes and its sizes read back.
// ---------------------------------------------------------------------

/** A big-endian unsigned 32-bit integer at `at`, without a signed shift. */
function u32(bytes, at) {
  return (
    (bytes[at] & 0xff) * 16777216 +
    (bytes[at + 1] & 0xff) * 65536 +
    (bytes[at + 2] & 0xff) * 256 +
    (bytes[at + 3] & 0xff)
  );
}

/** Four bytes at `at` as ASCII. */
function tag(bytes, at) {
  var out = "";
  for (var i = at; i < at + 4; i++) out += String.fromCharCode(bytes[i] & 0xff);
  return out;
}

/**
 * The pixel size a PNG says it has, read from its IHDR chunk, or null when
 * these bytes are not a PNG. Does not decode the image, so a wrong-width
 * receipt is refused before anything is stored.
 */
function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  var signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (var i = 0; i < 8; i++) {
    if ((bytes[i] & 0xff) !== signature[i]) return null;
  }
  if (u32(bytes, 8) !== 13 || tag(bytes, 12) !== "IHDR") return null;
  return { width: u32(bytes, 16), height: u32(bytes, 20) };
}

var crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c >>> 0);
    }
  }
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  var a = 1;
  var b = 0;
  for (var i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function be32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  var typed = [];
  for (var i = 0; i < 4; i++) typed.push(type.charCodeAt(i));
  var body = typed.concat(data);
  return be32(data.length).concat(body, be32(crc32(body)));
}

/**
 * A white PNG one pixel tall and `width` pixels across (8-bit greyscale),
 * for a drawer kick on a printer that did not list Star Line Mode. The
 * pixel data is a single stored (uncompressed) deflate block, which keeps
 * this free of a compressor and is 600 bytes for a full-width row.
 */
function whitePng(width) {
  var w = Math.max(1, Math.floor(width));
  var raw = [0]; // filter type: none
  for (var i = 0; i < w; i++) raw.push(0xff);
  var len = raw.length;
  var zlib = [0x78, 0x01, 0x01, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff]
    .concat(raw)
    .concat(be32(adler32(raw)));
  var header = be32(w).concat(be32(1), [8, 0, 0, 0, 0]);
  var out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return out.concat(chunk("IHDR", header), chunk("IDAT", zlib), chunk("IEND", []));
}

module.exports = {
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  MAX_PNG_BYTES: MAX_PNG_BYTES,
  MAX_PNG_HEIGHT: MAX_PNG_HEIGHT,
  MAX_TEXT: MAX_TEXT,
  MAX_COPIES: MAX_COPIES,
  STAR_LINE: STAR_LINE,
  KINDS: KINDS,
  PAPER_WIDTHS: PAPER_WIDTHS,
  pbDate: pbDate,
  parseStored: parseStored,
  toIso: toIso,
  hashToken: hashToken,
  newToken: newToken,
  findByToken: findByToken,
  authenticate: authenticate,
  macTaken: macTaken,
  normaliseMac: normaliseMac,
  pixelWidth: pixelWidth,
  printerUrl: printerUrl,
  encodingsOf: encodingsOf,
  supports: supports,
  isOnline: isOnline,
  registerNames: registerNames,
  shapePrinter: shapePrinter,
  shapeJob: shapeJob,
  printerForRegister: printerForRegister,
  noPrinterMessage: noPrinterMessage,
  queueJob: queueJob,
  queueDrawerKick: queueDrawerKick,
  oldestOpen: oldestOpen,
  readFileBytes: readFileBytes,
  pollAnswer: pollAnswer,
  parseEncodings: parseEncodings,
  decodeStatus: decodeStatus,
  recordPoll: recordPoll,
  serveNext: serveNext,
  settle: settle,
  tidy: tidy,
  pngSize: pngSize,
  whitePng: whitePng,
  crc32: crc32,
  adler32: adler32,
};
