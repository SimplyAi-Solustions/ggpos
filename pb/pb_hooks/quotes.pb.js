/// <reference path="../pb_data/types.d.ts" />

/**
 * quotes.pb.js - remote quotes, from a customer's photos to a draft buy-in
 * (docs/PLAN.md, "Remote quote to buy-in"; docs/api-contract.md's Phase 5
 * section for the exact shapes).
 *
 *   POST /api/vault/quotes                       (customer, multipart)
 *   GET  /api/vault/quotes/{id}                  (customer own, or staff)
 *   POST /api/vault/quotes/{id}/messages         (customer own, or staff)
 *   POST /api/vault/quotes/{id}/offer            (staff)
 *   POST /api/vault/quotes/{id}/reviewing        (staff)
 *   POST /api/vault/quotes/{id}/accept           (customer own)
 *   POST /api/vault/quotes/{id}/decline          (customer own)
 *   POST /api/vault/quotes/{id}/received         (staff)
 *   POST /api/vault/quotes/{id}/cancel           (staff)
 *
 * Plus the quotes_expire and quote_photos_retention crons, and the one
 * trade_ins hook that marks a quote completed once its converted trade-in
 * is completed. Logic beyond plumbing lives in lib/quotes.js and
 * lib/notify.js, per CLAUDE.md's "keep hooks small".
 *
 * Every write route runs inside one $app.runInTransaction, with a `halt`
 * object carrying an in-transaction refusal back out past the Go boundary -
 * the same pattern every Phase 2-4 route in this codebase uses (see
 * tradeins.pb.js's own file banner).
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/quotes   (customer, multipart)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotesLib = require(`${__hooks}/lib/quotes.js`);

    const MAX_PHOTOS = 20;
    const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

    const customer = e.auth;
    const body = util.body(e);

    function field(name) {
      const fromBody = util.asStr(body[name]);
      if (fromBody) return fromBody;
      try {
        return util.asStr(e.request.formValue(name));
      } catch (err) {
        return "";
      }
    }

    const message = field("message");
    if (message.length > 4000) {
      throw e.badRequestError("Keep the description to 4000 characters or fewer.", null);
    }
    let dropOff = field("drop_off");
    if (dropOff && dropOff !== "in_store" && dropOff !== "post") {
      throw e.badRequestError("Pick a drop-off of in_store or post.", null);
    }

    const uploads = e.findUploadedFiles("photos");
    if (!uploads || uploads.length === 0) {
      throw e.badRequestError("Add at least one photo of what you want valued.", null);
    }
    if (uploads.length > MAX_PHOTOS) {
      throw e.badRequestError(`Add at most ${MAX_PHOTOS} photos.`, null);
    }

    const files = [];
    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i];
      if (!upload) continue;
      if (upload.size > MAX_PHOTO_BYTES) {
        throw e.badRequestError(`Photo ${i + 1} is over 10 MB. Retake it at a lower resolution.`, null);
      }
      let bytes = null;
      let reader = null;
      try {
        reader = upload.reader.open();
        bytes = toBytes(reader, MAX_PHOTO_BYTES + 1);
      } catch (err) {
        throw e.badRequestError(`Photo ${i + 1} could not be read. Try adding it again.`, null);
      } finally {
        if (reader) {
          try {
            reader.close();
          } catch (err) {
            // Nothing useful to do if the reader will not close.
          }
        }
      }
      if (bytes.length > MAX_PHOTO_BYTES) {
        throw e.badRequestError(`Photo ${i + 1} is over 10 MB. Retake it at a lower resolution.`, null);
      }
      const mime = quotesLib.sniffImageMime(bytes);
      if (!mime) {
        throw e.badRequestError(
          `Photo ${i + 1} is not a JPEG, PNG or WebP image. Choose photos and try again.`,
          null
        );
      }
      files.push($filesystem.fileFromBytes(bytes, quotesLib.photoFileName(mime)));
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      const quote = new Record(txApp.findCollectionByNameOrId("quotes"), {
        customer: customer.id,
        status: "submitted",
        message: message,
        drop_off: dropOff || "in_store",
        lines: [],
        offer_total: 0,
      });
      quote.set("photos", files);
      txApp.save(quote);

      notifyLib.notify(txApp, {
        staffAll: true,
        type: "quote_submitted",
        title: "New quote submitted",
        body: `A customer has submitted a quote with ${files.length} photo${files.length === 1 ? "" : "s"}.`,
        link: "",
        email: true,
      });

      auditLib.writeAuditLog(txApp, {
        actor: customer.id,
        action: "quote_submit",
        collection: "quotes",
        record: quote.id,
        meta: { photos: files.length },
        ip: e.realIP(),
      });

      result = { quote: quote };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/quotes/{id}   (customer own, or staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/quotes/{id}",
  (e) => {
    const auth = e.auth;
    const isStaff = auth.collection().name === "staff";
    const quoteId = e.request.pathValue("id");

    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    // Never lets a customer learn that another customer's quote exists.
    if (!isStaff && quote.getString("customer") !== auth.id) {
      throw e.notFoundError("Quote not found.", null);
    }

    let messageRows = [];
    try {
      messageRows = e.app.findRecordsByFilter(
        "quote_messages",
        "quote = {:quote}",
        "created",
        0,
        0,
        { quote: quoteId }
      );
    } catch (err) {
      messageRows = [];
    }
    const messages = [];
    for (let i = 0; i < messageRows.length; i++) {
      const m = messageRows[i];
      if (!m) continue;
      messages.push({
        id: m.id,
        author: m.getString("author_kind"),
        body: m.getString("body"),
        created: m.getString("created"),
      });
    }

    // quotes.photos is a protected file field, so its URL only ever works
    // with a short-lived token minted from the caller's own auth record -
    // record.newFileToken() throws "not an auth collection record" on
    // anything else, which is exactly what the raw record is (pb/README.md,
    // "ID photos").
    let token = "";
    try {
      token = auth.newFileToken();
    } catch (err) {
      token = "";
    }
    const rawPhotos = quote.get("photos") || [];
    const photoNames = Array.isArray(rawPhotos) ? rawPhotos : [rawPhotos].filter(Boolean);
    const photos = [];
    for (let i = 0; i < photoNames.length; i++) {
      const name = photoNames[i];
      if (!name) continue;
      photos.push({
        name: name,
        url: `/api/files/quotes/${quote.id}/${name}${token ? "?token=" + token : ""}`,
      });
    }

    return e.json(200, { quote: quote, messages: messages, photos: photos });
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/messages   (customer own, or staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/messages",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const auth = e.auth;
    const isStaff = auth.collection().name === "staff";
    const quoteId = e.request.pathValue("id");

    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (!isStaff && quote.getString("customer") !== auth.id) {
      throw e.notFoundError("Quote not found.", null);
    }

    const body = util.body(e);
    const text = util.asStr(body.body);
    if (!text) {
      throw e.badRequestError("Write a message before sending.", null);
    }
    if (text.length > 2000) {
      throw e.badRequestError("Keep the message to 2000 characters or fewer.", null);
    }

    let result = null;
    e.app.runInTransaction((txApp) => {
      const record = new Record(txApp.findCollectionByNameOrId("quote_messages"), {
        quote: quoteId,
        author_kind: isStaff ? "staff" : "customer",
        body: text,
      });
      if (isStaff) {
        record.set("staff", auth.id);
      } else {
        record.set("customer", auth.id);
      }
      txApp.save(record);

      if (isStaff) {
        notifyLib.notify(txApp, {
          customer: quote.getString("customer"),
          type: "quote_message",
          title: "A message about your quote",
          body: text,
          link: "",
          email: true,
        });
      } else {
        notifyLib.notify(txApp, {
          staffAll: true,
          type: "quote_message",
          title: "A customer replied on a quote",
          body: text,
          link: "",
          email: false,
        });
      }

      auditLib.writeAuditLog(txApp, {
        actor: auth.id,
        action: "quote_message",
        collection: "quotes",
        record: quoteId,
        meta: { message: record.id },
        ip: e.realIP(),
      });

      result = {
        message: {
          id: record.id,
          author: record.getString("author_kind"),
          body: record.getString("body"),
          created: record.getString("created"),
        },
      };
    });

    return e.json(200, result);
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/offer   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/offer",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotesLib = require(`${__hooks}/lib/quotes.js`);
    const money = require(`${__hooks}/lib/shared/money.js`);

    const staff = e.auth;
    const quoteId = e.request.pathValue("id");

    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    const status = quote.getString("status");
    if (status !== "submitted" && status !== "reviewing") {
      throw e.error(409, `This quote is ${status} and cannot be offered on.`, null);
    }

    const body = util.body(e);
    const normalized = quotesLib.normalizeOfferLines(util, body.lines);
    if (!normalized.ok) {
      throw e.badRequestError(normalized.message, null);
    }
    const note = util.asStr(body.message);

    const settingsRow = util.settings(e.app);
    const expires = quotesLib.offerExpiry(e.app, settingsRow, new Date());

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        const liveStatus = live.getString("status");
        if (liveStatus !== "submitted" && liveStatus !== "reviewing") {
          halt = { status: 409, message: `This quote is ${liveStatus} and cannot be offered on.` };
          throw new Error(halt.message);
        }

        live.set("lines", normalized.lines);
        live.set("offer_total", normalized.offerTotal);
        live.set("offer_expires_at", expires.toISOString());
        live.set("status", "offered");
        txApp.save(live);

        if (note) {
          txApp.save(
            new Record(txApp.findCollectionByNameOrId("quote_messages"), {
              quote: quoteId,
              author_kind: "staff",
              staff: staff.id,
              body: note,
            })
          );
        }

        notifyLib.notify(txApp, {
          customer: live.getString("customer"),
          type: "quote_offered",
          title: `Your quote offer, ${money.formatGBP(normalized.offerTotal)}`,
          body:
            `We have offered ${money.formatGBP(normalized.offerTotal)} for your items. ` +
            `Sign in to review and accept or decline by ${quotesLib.ukDateShort(expires.toISOString())}.`,
          link: "",
          email: true,
        });

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "quote_offer",
          collection: "quotes",
          record: quoteId,
          meta: { lines: normalized.lines.length, offer_total: normalized.offerTotal },
          ip: e.realIP(),
        });

        result = { quote: live };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/reviewing   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/reviewing",
  (e) => {
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const quoteId = e.request.pathValue("id");
    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("status") !== "submitted") {
      throw e.error(409, `This quote is ${quote.getString("status")} and cannot be picked up now.`, null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        if (live.getString("status") !== "submitted") {
          halt = { status: 409, message: `This quote is ${live.getString("status")} and cannot be picked up now.` };
          throw new Error(halt.message);
        }
        live.set("status", "reviewing");
        txApp.save(live);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "quote_reviewing",
          collection: "quotes",
          record: quoteId,
          meta: {},
          ip: e.realIP(),
        });

        result = { quote: live };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/accept and /decline   (customer own)
//
// Two independent registrations rather than one shared by a small factory
// function: a value a wrapping function closes over is not guaranteed to
// survive into the isolated context a handler actually runs in at request
// time, the same reasoning a bare top-level const does not (pb/README.md).
// Every value either handler needs is therefore a literal inside its own
// handler body, at the cost of the two being near-identical.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/accept",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotesLib = require(`${__hooks}/lib/quotes.js`);
    const targetStatus = "accepted";
    const actionName = "quote_accept";

    const customer = e.auth;
    const quoteId = e.request.pathValue("id");
    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("customer") !== customer.id) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("status") !== "offered") {
      throw e.error(409, `This quote is ${quote.getString("status")}, not open for a reply.`, null);
    }
    const now = new Date();
    if (util.isPast(quote.getString("offer_expires_at"), now)) {
      throw e.error(
        409,
        `This offer expired on ${quotesLib.ukDateShort(quote.getString("offer_expires_at"))}. Ask for a new one.`,
        null
      );
    }

    const body = util.body(e);
    const reply = util.asStr(body.reply);
    const dropOff = util.asStr(body.drop_off);
    if (dropOff && dropOff !== "in_store" && dropOff !== "post") {
      throw e.badRequestError("Pick a drop-off of in_store or post.", null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        if (live.getString("status") !== "offered") {
          halt = { status: 409, message: `This quote is ${live.getString("status")}, not open for a reply.` };
          throw new Error(halt.message);
        }
        if (util.isPast(live.getString("offer_expires_at"), now)) {
          halt = {
            status: 409,
            message: `This offer expired on ${quotesLib.ukDateShort(live.getString("offer_expires_at"))}. Ask for a new one.`,
          };
          throw new Error(halt.message);
        }

        live.set("status", targetStatus);
        if (reply) live.set("customer_reply", reply);
        if (dropOff) live.set("drop_off", dropOff);
        txApp.save(live);

        notifyLib.notify(txApp, {
          staffAll: true,
          type: actionName,
          title: "A quote was accepted",
          body: `Quote ${quoteId} was accepted by the customer.`,
          link: "",
          email: false,
        });

        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: actionName,
          collection: "quotes",
          record: quoteId,
          meta: {},
          ip: e.realIP(),
        });

        result = { quote: live };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/quotes/{id}/decline",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);
    const quotesLib = require(`${__hooks}/lib/quotes.js`);
    const targetStatus = "declined";
    const actionName = "quote_decline";

    const customer = e.auth;
    const quoteId = e.request.pathValue("id");
    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("customer") !== customer.id) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("status") !== "offered") {
      throw e.error(409, `This quote is ${quote.getString("status")}, not open for a reply.`, null);
    }
    const now = new Date();
    if (util.isPast(quote.getString("offer_expires_at"), now)) {
      throw e.error(
        409,
        `This offer expired on ${quotesLib.ukDateShort(quote.getString("offer_expires_at"))}. Ask for a new one.`,
        null
      );
    }

    const body = util.body(e);
    const reply = util.asStr(body.reply);
    const dropOff = util.asStr(body.drop_off);
    if (dropOff && dropOff !== "in_store" && dropOff !== "post") {
      throw e.badRequestError("Pick a drop-off of in_store or post.", null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        if (live.getString("status") !== "offered") {
          halt = { status: 409, message: `This quote is ${live.getString("status")}, not open for a reply.` };
          throw new Error(halt.message);
        }
        if (util.isPast(live.getString("offer_expires_at"), now)) {
          halt = {
            status: 409,
            message: `This offer expired on ${quotesLib.ukDateShort(live.getString("offer_expires_at"))}. Ask for a new one.`,
          };
          throw new Error(halt.message);
        }

        live.set("status", targetStatus);
        if (reply) live.set("customer_reply", reply);
        if (dropOff) live.set("drop_off", dropOff);
        txApp.save(live);

        notifyLib.notify(txApp, {
          staffAll: true,
          type: actionName,
          title: "A quote was declined",
          body: `Quote ${quoteId} was declined by the customer.`,
          link: "",
          email: false,
        });

        auditLib.writeAuditLog(txApp, {
          actor: customer.id,
          action: actionName,
          collection: "quotes",
          record: quoteId,
          meta: {},
          ip: e.realIP(),
        });

        result = { quote: live };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/received   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/received",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const quoteId = e.request.pathValue("id");
    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (quote.getString("status") !== "accepted") {
      throw e.error(409, `This quote is ${quote.getString("status")}, not ready to receive.`, null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        if (live.getString("status") !== "accepted") {
          halt = { status: 409, message: `This quote is ${live.getString("status")}, not ready to receive.` };
          throw new Error(halt.message);
        }

        const tradeIn = new Record(txApp.findCollectionByNameOrId("trade_ins"), {
          customer: live.getString("customer"),
          channel: "remote",
          status: "draft",
          quote: quoteId,
        });
        txApp.save(tradeIn);

        const rawLines = util.jsonField(live, "lines", []) || [];
        const tradeInLines = txApp.findCollectionByNameOrId("trade_in_lines");
        for (let i = 0; i < rawLines.length; i++) {
          const l = rawLines[i] || {};
          const line = new Record(tradeInLines, {
            trade_in: tradeIn.id,
            card: util.asStr(l.card),
            retro_title: util.asStr(l.retro_title),
            free_text_title: util.asStr(l.title),
            finish: util.asStr(l.finish),
            condition: util.asStr(l.condition),
            qty: util.asInt(l.qty, 1),
            market_price: util.asInt(l.market_price, 0),
            market_currency: "GBP",
            market_source: util.asStr(l.market_source),
            offer_price: util.asInt(l.offer_price, 0),
            accepted: true,
          });
          txApp.save(line);
        }

        live.set("status", "received");
        txApp.save(live);

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "quote_received",
          collection: "quotes",
          record: quoteId,
          meta: { trade_in: tradeIn.id, lines: rawLines.length },
          ip: e.realIP(),
        });

        result = { trade_in_id: tradeIn.id, number: tradeIn.getString("number") };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/quotes/{id}/cancel   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/quotes/{id}/cancel",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    // Terminal already - cancelling one again is not "any open status".
    const CLOSED = ["declined", "expired", "completed", "received"];

    const staff = e.auth;
    const quoteId = e.request.pathValue("id");
    let quote = null;
    try {
      quote = e.app.findRecordById("quotes", quoteId);
    } catch (err) {
      throw e.notFoundError("Quote not found.", null);
    }
    if (CLOSED.indexOf(quote.getString("status")) >= 0) {
      throw e.error(409, `This quote is already ${quote.getString("status")}.`, null);
    }

    const body = util.body(e);
    const note = util.asStr(body.note);
    if (!note) {
      throw e.badRequestError("Say why this quote is being cancelled.", null);
    }

    let halt = null;
    let result = null;
    try {
      e.app.runInTransaction((txApp) => {
        const live = txApp.findRecordById("quotes", quoteId);
        if (CLOSED.indexOf(live.getString("status")) >= 0) {
          halt = { status: 409, message: `This quote is already ${live.getString("status")}.` };
          throw new Error(halt.message);
        }

        live.set("status", "declined");
        txApp.save(live);

        txApp.save(
          new Record(txApp.findCollectionByNameOrId("quote_messages"), {
            quote: quoteId,
            author_kind: "staff",
            staff: staff.id,
            body: note,
          })
        );

        notifyLib.notify(txApp, {
          customer: live.getString("customer"),
          type: "quote_declined",
          title: "Your quote was declined",
          body: note,
          link: "",
          email: true,
        });

        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "quote_cancel",
          collection: "quotes",
          record: quoteId,
          meta: {},
          ip: e.realIP(),
        });

        result = { quote: live };
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }

    return e.json(200, result);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// quotes.closed_at: stamped the moment status first reaches a closed state
// (completed, declined or expired), whichever route or cron got it there -
// the same shape as items.pb.js's own listed_at hook. This is what lets the
// quote_photos_retention cron below tell "closed 90 days ago" apart from
// "merely not touched in 90 days" (updated moves on a later reply too).
// ---------------------------------------------------------------------
onRecordUpdate((e) => {
  // Declared inside the handler, not at file top level: every registered
  // handler runs in its own isolated goja context, so a top-level const
  // referenced from in here is undefined at request time even though the
  // file loads and registers without complaint - see pb/README.md.
  const closedStatuses = ["completed", "declined", "expired"];
  const wasClosed = closedStatuses.indexOf(e.record.original().getString("status")) >= 0;
  const isClosed = closedStatuses.indexOf(e.record.getString("status")) >= 0;
  if (isClosed && !wasClosed) {
    e.record.set("closed_at", new Date().toISOString());
  }
  e.next();
}, "quotes");

// ---------------------------------------------------------------------
// trade_ins hook: a completed trade-in with a quote marks that quote
// completed (docs/api-contract.md's Phase 5 section). The one small hook
// this package adds to a Phase 2 collection - tradeins.pb.js's own
// completion route is not touched.
// ---------------------------------------------------------------------
onRecordUpdate((e) => {
  const wasCompleted = e.record.original().getString("status") === "completed";
  const isCompleted = e.record.getString("status") === "completed";
  const quoteId = e.record.getString("quote");

  e.next();

  if (isCompleted && !wasCompleted && quoteId) {
    try {
      const quote = e.app.findRecordById("quotes", quoteId);
      if (quote.getString("status") !== "completed") {
        quote.set("status", "completed");
        e.app.save(quote);
      }
    } catch (err) {
      console.log(`[quotes] could not mark quote ${quoteId} completed: ${err}`);
    }
  }
}, "trade_ins");

// ---------------------------------------------------------------------
// Cron: quotes_expire, hourly.
// ---------------------------------------------------------------------
cronAdd("quotes_expire", "0 * * * *", () => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const notifyLib = require(`${__hooks}/lib/notify.js`);
  const quotesLib = require(`${__hooks}/lib/quotes.js`);

  const now = new Date();
  const nowIso = now.toISOString();

  let offered = [];
  try {
    offered = $app.findRecordsByFilter(
      "quotes",
      'status = "offered" && offer_expires_at != ""',
      "",
      0,
      0
    );
  } catch (err) {
    offered = [];
  }

  let expiredCount = 0;
  let warnedCount = 0;
  for (let i = 0; i < offered.length; i++) {
    const quote = offered[i];
    if (!quote) continue;
    const expiresAt = quote.getString("offer_expires_at");
    if (util.isPast(expiresAt, now)) {
      quote.set("status", "expired");
      $app.save(quote);
      expiredCount += 1;
      notifyLib.notify($app, {
        customer: quote.getString("customer"),
        type: "quote_expired",
        title: "Your quote offer has expired",
        body: `The offer on your quote expired on ${quotesLib.ukDateShort(expiresAt)}. Ask for a new one any time.`,
        link: "",
        email: true,
      });
      continue;
    }

    // A day before expiry, one quote_expiring notification - guarded by
    // notified_at-less duplication being acceptable at most once an hour,
    // since this cron only ever looks at "offered" quotes and a fresh
    // notification row is cheap; the want-list match's own notified_at
    // pattern is not reused here because a quote offer already carries its
    // own expiry the customer can see any time in the portal.
    const hoursLeft = (new Date(expiresAt).getTime() - now.getTime()) / 3600000;
    if (hoursLeft > 0 && hoursLeft <= 24) {
      let alreadyWarned = false;
      try {
        alreadyWarned =
          $app
            .findRecordsByFilter(
              "notifications",
              'type = "quote_expiring" && customer = {:customer} && link = {:link}',
              "",
              1,
              0,
              { customer: quote.getString("customer"), link: `/quotes/${quote.id}` }
            )
            .length > 0;
      } catch (err) {
        alreadyWarned = false;
      }
      if (!alreadyWarned) {
        notifyLib.notify($app, {
          customer: quote.getString("customer"),
          type: "quote_expiring",
          title: "Your quote offer expires soon",
          body: `Your quote offer expires on ${quotesLib.ukDateShort(expiresAt)}. Sign in to accept or decline.`,
          link: `/quotes/${quote.id}`,
          email: true,
        });
        warnedCount += 1;
      }
    }
  }

  if (expiredCount > 0 || warnedCount > 0) {
    console.log(`[cron:quotes_expire] expired=${expiredCount} expiring_warned=${warnedCount} at ${nowIso}`);
  }
});

// ---------------------------------------------------------------------
// Cron: quote_photos_retention, nightly. Photos are deleted 90 days after
// a quote reaches completed, declined or expired - see docs/PLAN.md's
// retention rules and docs/retention-schedule.md.
// ---------------------------------------------------------------------
cronAdd("quote_photos_retention", "30 3 * * *", () => {
  const RETENTION_DAYS = 90;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
  // PocketBase's own stored date form (a space, not "T") - see
  // pb_hooks/crons.pb.js's own pbDate() and exports.pb.js's acquired_at
  // range for the same reason.
  const cutoffPb = cutoff.toISOString().replace("T", " ");

  let quotes = [];
  try {
    quotes = $app.findRecordsByFilter(
      "quotes",
      `closed_at != "" && closed_at <= {:cutoff} && photos != ""`,
      "",
      0,
      0,
      { cutoff: cutoffPb }
    );
  } catch (err) {
    quotes = [];
  }

  let cleared = 0;
  for (let i = 0; i < quotes.length; i++) {
    const quote = quotes[i];
    if (!quote) continue;
    quote.set("photos", []);
    $app.save(quote);
    cleared += 1;
  }
  if (cleared > 0) {
    console.log(`[cron:quote_photos_retention] cleared photos on ${cleared} quote(s)`);
  }
});
