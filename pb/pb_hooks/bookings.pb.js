/// <reference path="../pb_data/types.d.ts" />

/**
 * bookings.pb.js - bookings on the server (docs/api-contract-launch.md,
 * section 4): tables, PC and console stations and rooms by the slot, walk-in
 * sessions on the stations, and tournaments and events with their entries.
 *
 *   GET  /api/vault/bookings/availability?date=&kind=&party=  (staff)
 *   GET  /api/public/availability?date=&kind=&party=          (anyone)
 *   GET  /api/vault/bookings?from=&to=&resource=&event=&customer=&status=  (staff)
 *   POST /api/vault/bookings                    (bookings_manage, or a customer for themselves)
 *   GET  /api/vault/bookings/stations           (staff)
 *   POST /api/vault/bookings/walk-in            (bookings_manage)
 *   GET  /api/vault/bookings/{id}               (staff, or the customer whose it is)
 *   POST /api/vault/bookings/{id}/move          (bookings_manage)
 *   POST /api/vault/bookings/{id}/cancel        (bookings_manage, or the customer whose it is)
 *   POST /api/vault/bookings/{id}/no-show       (bookings_manage)
 *   POST /api/vault/bookings/{id}/check-in      (bookings_manage)
 *   POST /api/vault/bookings/{id}/check-out     (bookings_manage)
 *   GET  /api/vault/me/bookings                 (customer)
 *   GET  /api/vault/events?from=&to=&status=    (staff)
 *   GET  /api/vault/events/{id}                 (staff)
 *   POST /api/vault/events/{id}/check-in        (bookings_manage)
 *   POST /api/vault/events/{id}/cancel          (manager or admin)
 *   GET  /api/public/events?from=&to=           (anyone)
 *
 * plus the record hooks that keep `booking_events`, `resources` and the
 * shop's opening hours sound when managers write them through the
 * collection API. Paying for a booking is a `booking` line on
 * `POST /api/vault/sales/complete` (sales.pb.js, lib/salerefund.js); the
 * day-before reminders and the weekly events are bookings_crons.pb.js.
 *
 * Logic in lib/bookings.js, every slot, clash, price and charge from
 * packages/shared/src/bookings.ts. Same shape as the sale route: validate
 * first, then one $app.runInTransaction with every write through txApp, a
 * `halt` object carrying an in-transaction refusal out past the Go
 * boundary, and mail sent once the transaction has committed.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/bookings/availability   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/bookings/availability",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const shared = require(`${__hooks}/lib/shared/bookings.js`);

    const date = lib.dateParam(csvLib.queryParam(e, "date"));
    if (!date) throw e.badRequestError("Pick a day, for example 2026-10-16.", null);
    const kind = csvLib.queryParam(e, "kind");
    if (kind && shared.RESOURCE_KINDS.indexOf(kind) < 0) {
      throw e.badRequestError("Pick a kind: table, pc, console or room.", null);
    }
    const party = util.asInt(csvLib.queryParam(e, "party"), 0);
    return e.json(200, lib.availability(e.app, { date: date, kind: kind, party: party, now: new Date() }));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/public/availability   (anyone: My Vault and the website)
//
// Only resources bookable online, and nothing but free and busy slots: no
// booking, name or customer detail of any kind.
// ---------------------------------------------------------------------
routerAdd("GET", "/api/public/availability", (e) => {
  const csvLib = require(`${__hooks}/lib/csv.js`);
  const lib = require(`${__hooks}/lib/bookings.js`);
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const shared = require(`${__hooks}/lib/shared/bookings.js`);

  const date = lib.dateParam(csvLib.queryParam(e, "date"));
  if (!date) throw e.badRequestError("Pick a day, for example 2026-10-16.", null);
  const kind = csvLib.queryParam(e, "kind");
  if (kind && shared.RESOURCE_KINDS.indexOf(kind) < 0) {
    throw e.badRequestError("Pick a kind: table, pc, console or room.", null);
  }
  const party = util.asInt(csvLib.queryParam(e, "party"), 0);
  return e.json(
    200,
    lib.availability(e.app, { date: date, kind: kind, party: party, now: new Date(), publicOnly: true })
  );
});

// ---------------------------------------------------------------------
// GET /api/vault/bookings   (staff)
//
// The day and week views: bookings starting in a range of shop days (today
// when none is given, six weeks at most), or every entry of one event.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/bookings",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const shared = require(`${__hooks}/lib/shared/bookings.js`);

    const params = {};
    const parts = [];
    const eventId = csvLib.queryParam(e, "event");
    if (eventId) {
      parts.push("event = {:event}");
      params.event = eventId;
    } else {
      const today = shared.shopDateOf(new Date());
      const sentFrom = csvLib.queryParam(e, "from");
      const sentTo = csvLib.queryParam(e, "to");
      const from = sentFrom ? lib.dateParam(sentFrom) : today;
      const to = sentTo ? lib.dateParam(sentTo) : from;
      if (!from || !to) throw e.badRequestError("Pick the days as dates, for example 2026-10-16.", null);
      if (to < from) throw e.badRequestError("The last day comes before the first. Swap them round.", null);
      if (shared.addDays(from, 41) < to) throw e.badRequestError("Ask for six weeks at most.", null);
      parts.push("starts_at >= {:from} && starts_at < {:to}");
      params.from = lib.pbDate(shared.shopDayBounds(from).starts_at);
      params.to = lib.pbDate(shared.shopDayBounds(to).ends_at);
    }
    const resourceId = csvLib.queryParam(e, "resource");
    if (resourceId) {
      parts.push("resource = {:resource}");
      params.resource = resourceId;
    }
    const customerId = csvLib.queryParam(e, "customer");
    if (customerId) {
      parts.push("customer = {:customer}");
      params.customer = customerId;
    }
    const status = csvLib.queryParam(e, "status");
    if (status) {
      if (shared.BOOKING_STATUSES.indexOf(status) < 0) {
        throw e.badRequestError("Pick a status: held, confirmed, checked_in, completed, cancelled or no_show.", null);
      }
      parts.push("status = {:status}");
      params.status = status;
    }

    let records = [];
    try {
      records = e.app.findRecordsByFilter("bookings", parts.join(" && "), "starts_at,created", 1000, 0, params);
    } catch (err) {
      records = [];
    }
    return e.json(200, { bookings: lib.views(e.app, records) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings   (bookings_manage, or a customer for themselves)
//
// A table, station or room by the slot ({ resource, starts_at, ends_at }),
// or an entry to an event ({ event, waitlist?, free_entry? }), for a
// customer or a name, phone and email, with a party size. Answers the
// booking (BookingView). A clash is 409 with the contract's sentence; the
// overlap and an event's places are checked again inside the transaction.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const body = util.body(e);
    const now = new Date();
    const byCustomer = e.auth.collection().name === "customers";
    const ctx = {
      actor: byCustomer ? "customer" : "staff",
      customer: byCustomer ? e.auth : null,
      staffId: byCustomer ? "" : e.auth.id,
      ip: e.realIP(),
      now: now,
    };

    const ready = lib.prepareCreate(e.app, body, ctx);
    if (!ready.ok) throw e.error(ready.status, ready.message, null);

    // Capability last, so a manager is only asked to approve a booking that
    // will otherwise go through.
    if (!byCustomer) {
      const grant = perms.check(e, "bookings_manage");
      if (!grant.ok) return perms.refuse(e, grant);
    }

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.writeCreate(txApp, ready.plan, ctx);
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    notifyLib.sendPending(e.app, done.pending);
    return e.json(200, lib.view(e.app, done.record, { forCustomer: byCustomer }));
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/bookings/stations   (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/bookings/stations",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    return e.json(200, { stations: lib.stations(e.app, new Date()) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings/walk-in   (bookings_manage)
//
// A walk-in session on a PC or console station: checked in now with no
// booking ahead of it. The clock runs until check-out charges it.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings/walk-in",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const now = new Date();
    const ready = lib.prepareWalkIn(e.app, util.body(e), now);
    if (!ready.ok) throw e.error(ready.status, ready.message, null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.writeWalkIn(txApp, ready.plan, { staffId: e.auth.id, ip: e.realIP(), now: now });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, lib.view(e.app, done.record));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/bookings/{id}   (staff, or the customer whose it is)
//
// Staff also get `payments`: the sale lines that paid towards it.
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/bookings/{id}",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    const byCustomer = e.auth.collection().name === "customers";
    // Somebody else's booking reads exactly like one that does not exist.
    if (!booking || (byCustomer && booking.getString("customer") !== e.auth.id)) {
      throw e.notFoundError("That booking was not found.", null);
    }
    const out = lib.view(e.app, booking, { forCustomer: byCustomer });
    if (!byCustomer) {
      out.payments = lib.payments(e.app, booking.id).map((p) => ({
        sale: p.sale,
        sale_line: p.sale_line,
        amount: p.amount,
      }));
    }
    return e.json(200, out);
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings/{id}/move   (bookings_manage)
//
// { starts_at, ends_at, resource? }: another time and, optionally, another
// table, station or room; repriced, never below what has been paid.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings/{id}/move",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const now = new Date();
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    if (!booking) throw e.notFoundError("That booking was not found. Reload the bookings.", null);
    const ready = lib.prepareMove(e.app, booking, util.body(e), now);
    if (!ready.ok) throw e.error(ready.status, ready.message, null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.writeMove(txApp, ready.plan, { staffId: e.auth.id, ip: e.realIP(), now: now });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, lib.view(e.app, done.record));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings/{id}/cancel   (bookings_manage, or the customer)
//
// Staff: { keep_deposit?: bool }. Answers the booking with `refunds`, the
// sale lines the till refunds through its refund flow
// (POST /api/vault/sales/{id}/refund, which takes them off `paid`), and
// `kept`, what stays with the shop. A customer cancels their own booking
// that has not started and has nothing paid.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings/{id}/cancel",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const now = new Date();
    const byCustomer = e.auth.collection().name === "customers";
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    if (!booking || (byCustomer && booking.getString("customer") !== e.auth.id)) {
      throw e.notFoundError("That booking was not found.", null);
    }
    const ctx = {
      actor: byCustomer ? "customer" : "staff",
      staffId: byCustomer ? "" : e.auth.id,
      ip: e.realIP(),
      now: now,
    };
    const ready = lib.prepareCancel(e.app, booking, util.body(e), ctx);
    if (!ready.ok) throw e.error(ready.status, ready.message, null);
    if (!byCustomer) {
      const grant = perms.check(e, "bookings_manage");
      if (!grant.ok) return perms.refuse(e, grant);
    }

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.writeCancel(txApp, ready.plan, ctx);
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    notifyLib.sendPending(e.app, done.pending);
    const out = lib.view(e.app, done.record, { forCustomer: byCustomer });
    out.refunds = ready.plan.refunds;
    out.kept = ready.plan.kept;
    return e.json(200, out);
  },
  $apis.requireAuth("staff", "customers")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings/{id}/no-show    (bookings_manage)
// POST /api/vault/bookings/{id}/check-in   (bookings_manage)
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings/{id}/no-show",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const now = new Date();
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    if (!booking) throw e.notFoundError("That booking was not found. Reload the bookings.", null);
    const problem = lib.noShowProblem(booking, now);
    if (problem) throw e.error(problem.status, problem.message, null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.setStatus(txApp, booking.id, "no_show", { staffId: e.auth.id, ip: e.realIP(), now: now });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    notifyLib.sendPending(e.app, done.pending);
    return e.json(200, lib.view(e.app, done.record));
  },
  $apis.requireAuth("staff")
);

routerAdd(
  "POST",
  "/api/vault/bookings/{id}/check-in",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const now = new Date();
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    if (!booking) throw e.notFoundError("That booking was not found. Reload the bookings.", null);
    const problem = lib.checkInProblem(e.app, booking, now);
    if (problem) throw e.error(problem.status, problem.message, null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.setStatus(txApp, booking.id, "checked_in", { staffId: e.auth.id, ip: e.realIP(), now: now });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, lib.view(e.app, done.record));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/bookings/{id}/check-out   (bookings_manage)
//
// Answers the booking with `charge`: { minutes, slots, price, balance },
// the balance being what the till takes as a booking line.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/bookings/{id}/check-out",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const now = new Date();
    const booking = lib.findById(e.app, "bookings", e.request.pathValue("id"));
    if (!booking) throw e.notFoundError("That booking was not found. Reload the bookings.", null);
    const status = booking.getString("status");
    if (status === "completed") throw e.error(409, "This booking has already checked out.", null);
    if (status !== "checked_in") throw e.error(409, "This booking has not checked in.", null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.checkOut(txApp, booking.id, { staffId: e.auth.id, ip: e.realIP(), now: now });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    const out = lib.view(e.app, done.record);
    out.charge = done.charge;
    return e.json(200, out);
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/me/bookings   (customer)
//
// Their own bookings and entries from 30 days ago on, soonest first, with
// the names of what they booked (resources and events are staff-only
// collections).
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/me/bookings",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const since = lib.pbDate(new Date(Date.now() - 30 * 86400000));
    let records = [];
    try {
      records = e.app.findRecordsByFilter(
        "bookings",
        "customer = {:customer} && starts_at >= {:since}",
        "starts_at",
        100,
        0,
        { customer: e.auth.id, since: since }
      );
    } catch (err) {
      records = [];
    }
    return e.json(200, { bookings: lib.views(e.app, records, { forCustomer: true }) });
  },
  $apis.requireAuth("customers")
);

// ---------------------------------------------------------------------
// GET /api/vault/events?from=&to=&status=   (staff)
// GET /api/vault/events/{id}                (staff)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/events",
  (e) => {
    const csvLib = require(`${__hooks}/lib/csv.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const shared = require(`${__hooks}/lib/shared/bookings.js`);

    const today = shared.shopDateOf(new Date());
    const sentFrom = csvLib.queryParam(e, "from");
    const sentTo = csvLib.queryParam(e, "to");
    const from = sentFrom ? lib.dateParam(sentFrom) : today;
    const to = sentTo ? lib.dateParam(sentTo) : shared.addDays(from || today, 60);
    if (!from || !to) throw e.badRequestError("Pick the days as dates, for example 2026-10-16.", null);
    if (to < from) throw e.badRequestError("The last day comes before the first. Swap them round.", null);
    if (shared.addDays(from, 366) < to) throw e.badRequestError("Ask for a year at most.", null);
    const params = {
      from: lib.pbDate(shared.shopDayBounds(from).starts_at),
      to: lib.pbDate(shared.shopDayBounds(to).ends_at),
    };
    let filter = "ends_at > {:from} && starts_at < {:to}";
    const status = csvLib.queryParam(e, "status");
    if (status) {
      if (["draft", "published", "cancelled", "finished"].indexOf(status) < 0) {
        throw e.badRequestError("Pick a status: draft, published, cancelled or finished.", null);
      }
      filter += " && status = {:status}";
      params.status = status;
    }
    let records = [];
    try {
      records = e.app.findRecordsByFilter("booking_events", filter, "starts_at", 500, 0, params);
    } catch (err) {
      records = [];
    }
    return e.json(200, { events: lib.eventViews(e.app, records) });
  },
  $apis.requireAuth("staff")
);

routerAdd(
  "GET",
  "/api/vault/events/{id}",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const event = lib.findById(e.app, "booking_events", e.request.pathValue("id"));
    if (!event) throw e.notFoundError("That event was not found. Reload the events.", null);
    let entries = [];
    try {
      entries = e.app.findRecordsByFilter("bookings", "event = {:event} && kind = 'event'", "created,id", 0, 0, {
        event: event.id,
      });
    } catch (err) {
      entries = [];
    }
    return e.json(200, { event: lib.eventViews(e.app, [event])[0], entries: lib.views(e.app, entries) });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/events/{id}/check-in   (bookings_manage)
//
// { qr } (the Guild card's QR, its portal link or the bare token), { code }
// (the customer code as printed) or { customer }: checks in that customer's
// entry. Answers the entry (BookingView).
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/events/{id}/check-in",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const lib = require(`${__hooks}/lib/bookings.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);

    const now = new Date();
    const event = lib.findById(e.app, "booking_events", e.request.pathValue("id"));
    if (!event) throw e.notFoundError("That event was not found. Reload the events.", null);
    const body = util.body(e);
    if (!util.asStr(body.qr) && !util.asStr(body.code) && !util.asStr(body.customer)) {
      throw e.badRequestError("Scan the customer's Guild card or type their code.", null);
    }
    const customer = lib.customerFromScan(e.app, body);
    if (!customer) throw e.notFoundError("That card was not found. Scan it again or type the code.", null);
    const entry = lib.entryOf(e.app, event.id, customer.id);
    if (!entry) {
      throw e.notFoundError(
        customer.getString("name") + " is not entered in " + event.getString("name") + ". Add them as an entry first.",
        null
      );
    }
    const problem = lib.checkInProblem(e.app, entry, now);
    if (problem) throw e.error(problem.status, problem.message, null);
    const grant = perms.check(e, "bookings_manage");
    if (!grant.ok) return perms.refuse(e, grant);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.setStatus(txApp, entry.id, "checked_in", { staffId: e.auth.id, ip: e.realIP(), now: now, via: "qr" });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    return e.json(200, lib.view(e.app, done.record));
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/events/{id}/cancel   (manager or admin, as the
// collection's own rules for events)
//
// The event and every live entry cancelled, each customer told. Answers
// { event, cancelled, refunds }: the sale lines the till refunds.
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/events/{id}/cancel",
  (e) => {
    const lib = require(`${__hooks}/lib/bookings.js`);
    const notifyLib = require(`${__hooks}/lib/notify.js`);

    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw e.forbiddenError("Only a manager can cancel an event. Ask one to do it.", null);
    }
    const event = lib.findById(e.app, "booking_events", e.request.pathValue("id"));
    if (!event) throw e.notFoundError("That event was not found. Reload the events.", null);

    let halt = null;
    let done = null;
    try {
      e.app.runInTransaction((txApp) => {
        done = lib.cancelEvent(txApp, event.id, { staffId: e.auth.id, ip: e.realIP(), now: new Date() });
        if (!done.ok) {
          halt = { status: done.status, message: done.message };
          throw new Error(halt.message);
        }
      });
    } catch (err) {
      if (halt) throw e.error(halt.status, halt.message, null);
      throw err;
    }
    notifyLib.sendPending(e.app, done.pending);
    return e.json(200, {
      event: lib.eventViews(e.app, [done.event])[0],
      cancelled: done.cancelled,
      refunds: done.refunds,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/public/events?from=&to=   (anyone: My Vault and the website)
//
// Published events open to online entries, from today (or `from`) for 60
// days (or to `to`), with the places left. No entry or customer detail.
// ---------------------------------------------------------------------
routerAdd("GET", "/api/public/events", (e) => {
  const csvLib = require(`${__hooks}/lib/csv.js`);
  const lib = require(`${__hooks}/lib/bookings.js`);
  const shared = require(`${__hooks}/lib/shared/bookings.js`);

  const today = shared.shopDateOf(new Date());
  const sentFrom = csvLib.queryParam(e, "from");
  const sentTo = csvLib.queryParam(e, "to");
  const from = sentFrom ? lib.dateParam(sentFrom) : today;
  const to = sentTo ? lib.dateParam(sentTo) : shared.addDays(from || today, 60);
  if (!from || !to) throw e.badRequestError("Pick the days as dates, for example 2026-10-16.", null);
  if (to < from) throw e.badRequestError("The last day comes before the first. Swap them round.", null);
  if (shared.addDays(from, 92) < to) throw e.badRequestError("Ask for three months at most.", null);
  const start = shared.shopDayBounds(from).starts_at;
  const params = {
    from: lib.pbDate(Date.parse(start) > Date.now() ? start : new Date()),
    to: lib.pbDate(shared.shopDayBounds(to).ends_at),
  };
  let records = [];
  try {
    records = e.app.findRecordsByFilter(
      "booking_events",
      "status = 'published' && online = true && starts_at >= {:from} && starts_at < {:to}",
      "starts_at",
      200,
      0,
      params
    );
  } catch (err) {
    records = [];
  }
  return e.json(200, { events: lib.eventViews(e.app, records) });
});

// ---------------------------------------------------------------------
// booking_events through the collection API (managers and admins create
// and publish there): the times, cancelling through its route, no clash
// with a booked table once published, the entries following a change of
// time in the same transaction, and an audit row naming what changed.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const lib = require(`${__hooks}/lib/bookings.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);
  const problem = lib.eventWriteProblem(e.app, e.record, true);
  if (problem) throw e.error(problem.status, problem.message, null);
  e.next();
  auditLib.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "superuser",
    action: "event_create",
    collection: "booking_events",
    record: e.record.id,
    meta: { status: e.record.getString("status"), starts_at: lib.iso(e.record.getString("starts_at")) },
    ip: e.realIP(),
  });
}, "booking_events");

onRecordUpdateRequest((e) => {
  const lib = require(`${__hooks}/lib/bookings.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);
  const problem = lib.eventWriteProblem(e.app, e.record, false);
  if (problem) throw e.error(problem.status, problem.message, null);
  const fields = lib.changedFields(e.record);
  if (lib.eventTimesChanged(e.record)) {
    lib.nextInTransaction(e);
  } else {
    e.next();
  }
  auditLib.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "superuser",
    action: "event_update",
    collection: "booking_events",
    record: e.record.id,
    meta: { fields: fields, status: e.record.getString("status") },
    ip: e.realIP(),
  });
}, "booking_events");

// Whoever saves an event (the route above, the repeat cron), its live
// entries keep its times. Runs inside the caller's transaction.
onRecordUpdate((e) => {
  const lib = require(`${__hooks}/lib/bookings.js`);
  const moved = lib.eventTimesChanged(e.record);
  e.next();
  if (moved) lib.followEvent(e.app, e.record);
}, "booking_events");

// ---------------------------------------------------------------------
// resources and settings.opening_hours through the collection API: hours
// the shared slot maths can read, and an audit row for a resource.
// ---------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const shared = require(`${__hooks}/lib/shared/bookings.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);
  const problem = shared.hoursProblem(util.jsonField(e.record, "hours", null));
  if (problem) throw e.badRequestError(problem, null);
  e.next();
  auditLib.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "superuser",
    action: "resource_create",
    collection: "resources",
    record: e.record.id,
    meta: { kind: e.record.getString("kind") },
    ip: e.realIP(),
  });
}, "resources");

onRecordUpdateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const shared = require(`${__hooks}/lib/shared/bookings.js`);
  const lib = require(`${__hooks}/lib/bookings.js`);
  const auditLib = require(`${__hooks}/lib/audit.js`);
  const problem = shared.hoursProblem(util.jsonField(e.record, "hours", null));
  if (problem) throw e.badRequestError(problem, null);
  const fields = lib.changedFields(e.record);
  e.next();
  auditLib.writeAuditLog(e.app, {
    actor: e.auth ? e.auth.id : "superuser",
    action: "resource_update",
    collection: "resources",
    record: e.record.id,
    meta: { fields: fields },
    ip: e.realIP(),
  });
}, "resources");

onRecordUpdateRequest((e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const shared = require(`${__hooks}/lib/shared/bookings.js`);
  const problem = shared.hoursProblem(util.jsonField(e.record, "opening_hours", null));
  if (problem) throw e.badRequestError(problem, null);
  e.next();
}, "settings");
