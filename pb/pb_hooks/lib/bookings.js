/**
 * Bookings on the server (docs/api-contract-launch.md, section 4): tables,
 * PC and console stations and rooms by the slot, walk-in sessions on the
 * stations, events and their entries, and paying for any of them at the till.
 *
 * Every slot, clash, price, session charge, place count and waitlist comes
 * from packages/shared/src/bookings.ts (through lib/shared/bookings.js), so
 * the day view, My Vault and demo mode can never offer a slot or a price this
 * server would refuse. This file is the PocketBase half: reading records into
 * the shapes the shared functions take, the busy windows a resource has, the
 * refusals and their sentences, and the writes, each re-checked inside the
 * caller's transaction.
 *
 * - `availability`, `busyFor`, `placeProblem`: what is free, and why a window
 *   is not. Overlap is checked before the transaction and again inside it,
 *   with the transaction's own reads, so two tills cannot book one slot.
 * - `prepareCreate` / `writeCreate`, `prepareMove` / `writeMove`,
 *   `prepareCancel` / `writeCancel`, `walkIn`, `setStatus`, `checkOut`: the
 *   booking routes' checks and writes ("validate first, write second", with
 *   refusals carried out of the transaction as `{ ok: false, status,
 *   message }` for the route's `halt`).
 * - `saleLine`, `settle`, `unpay`: a booking on a sale line. `saleLine`
 *   prices it before the sale's transaction, `settle` moves `paid` and
 *   confirms a held booking inside it, and `unpay` takes a refunded line back
 *   off `paid` inside the refund's.
 * - `view` / `views`, `eventView`: what the routes answer (`BookingView`,
 *   `EventView`).
 * - `remind` and `repeatEvents`: the two crons in bookings_crons.pb.js.
 *
 * Dates: PocketBase stores "2026-10-16 17:00:00.000Z" (a space, not "T"), so
 * every value read is turned into ISO 8601 before a shared function sees it
 * (`iso`), and every filter bound is written in the stored form (`pbDate`).
 *
 * Audit meta stays to identifiers, times and the shop's own money, never a
 * customer's name, phone or email (pb/README.md).
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** A booking in one of these takes its time up; `completed` also holds an event place. */
var LIVE = ["held", "confirmed", "checked_in"];
var STATIONS = ["pc", "console"];
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shared() {
  return require(__hooks + "/lib/shared/bookings.js");
}

function refusal(status, message) {
  return { ok: false, status: status, message: message };
}

// ---------------------------------------------------------------------
// Dates and plain values
// ---------------------------------------------------------------------

/** ISO 8601 from a stored date ("2026-10-16 17:00:00.000Z"), or "" when empty or unreadable. */
function iso(value) {
  var s = String(value === null || value === undefined ? "" : value).trim();
  if (!s) return "";
  var t = Date.parse(s.replace(" ", "T"));
  return isNaN(t) ? "" : new Date(t).toISOString();
}

/** An instant in PocketBase's stored form, for a filter bound. */
function pbDate(value) {
  var d = value instanceof Date ? value : new Date(value);
  return d.toISOString().replace("T", " ");
}

/** A request's instant (an ISO string), or null when it is not one. */
function instant(value) {
  var s = String(value === null || value === undefined ? "" : value).trim();
  if (!s) return null;
  var t = Date.parse(s.replace(" ", "T"));
  return isNaN(t) ? null : new Date(t);
}

/** A request's shop-time date ("2026-10-16"), or "" when it is not one. */
function dateParam(value) {
  var s = String(value === null || value === undefined ? "" : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  var t = Date.parse(s + "T00:00:00Z");
  if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return "";
  return s;
}

/** "Fri 16 Oct", shop time. */
function dayLabel(isoValue) {
  var b = shared();
  var date = b.shopDateOf(new Date(isoValue));
  var parts = date.split("-");
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
}

/** A JS array from an untyped value, [] when it is not a list. */
function listOf(value) {
  if (!value || typeof value !== "object" || typeof value.length !== "number") return [];
  var out = [];
  for (var i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

/** A relation field's ids as a JS array. */
function idsOf(record, field) {
  try {
    return listOf(record.getStringSlice(field));
  } catch (err) {
    var one = record.getString(field);
    return one ? [one] : [];
  }
}

function findById(app, collection, id) {
  if (!id) return null;
  try {
    return app.findRecordById(collection, id);
  } catch (err) {
    return null;
  }
}

function findAll(app, collection, filter, sort, params) {
  try {
    return app.findRecordsByFilter(collection, filter, sort || "", 0, 0, params || {});
  } catch (err) {
    return [];
  }
}

/** Records by id, as a map, in one query per collection. */
function byIds(app, collection, ids) {
  var unique = [];
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] && !seen[ids[i]]) {
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
  }
  var map = {};
  if (!unique.length) return map;
  var rows = [];
  try {
    rows = app.findRecordsByIds(collection, unique);
  } catch (err) {
    rows = [];
  }
  for (var j = 0; j < rows.length; j++) {
    if (rows[j]) map[rows[j].id] = rows[j];
  }
  return map;
}

/** `field = {:p0} || field = {:p1} ...` and its params, for a list of ids. */
function anyOf(field, ids, prefix, params, op) {
  var parts = [];
  for (var i = 0; i < ids.length; i++) {
    params[prefix + i] = ids[i];
    parts.push(field + " " + (op || "=") + " {:" + prefix + i + "}");
  }
  return "(" + parts.join(" || ") + ")";
}

// ---------------------------------------------------------------------
// Settings, resources and customers in the shared shapes
// ---------------------------------------------------------------------

/** The shop's opening hours from settings, {} (closed) when unset or unreadable. */
function shopHours(app) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var row = util.settings(app);
  if (!row) return {};
  var value = util.jsonField(row, "opening_hours", null);
  return value && !shared().hoursProblem(value) ? value : {};
}

/**
 * A `resources` record as the shared `BookableResource`. A number field
 * PocketBase has never been given reads 0, so a member price or a deposit of
 * 0 means none, a capacity of 0 means no limit, and a slot of under 5
 * minutes means the default hour.
 */
function resourceShape(record) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var hours = util.jsonField(record, "hours", null);
  if (hours && shared().hoursProblem(hours)) hours = null;
  var slot = record.getInt("slot_minutes");
  var member = record.getInt("member_price");
  var deposit = record.getInt("deposit");
  return {
    id: record.id,
    name: record.getString("name"),
    kind: record.getString("kind"),
    capacity: Math.max(0, record.getInt("capacity")),
    slot_minutes: slot >= 5 ? slot : 60,
    price: Math.max(0, record.getInt("price")),
    member_price: member > 0 ? member : null,
    deposit: deposit > 0 ? deposit : null,
    online: record.getBool("online"),
    hours: hours && typeof hours === "object" && Object.keys(hours).length ? hours : null,
    active: record.getBool("active"),
    sort: record.getInt("sort"),
  };
}

/** What availability and the stations strip say about a resource. */
function resourceSummary(shape) {
  return {
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    capacity: shape.capacity,
    slot_minutes: shape.slot_minutes,
    price: shape.price,
    member_price: shape.member_price,
    deposit: shape.deposit,
  };
}

/** A Guild member: a customer who has joined (launch contract, section 1). */
function isMember(customer) {
  return !!(customer && customer.getString("guild_joined_at"));
}

/** An event's fees in the shared `entryFee` shape: a member fee of 0 means none. */
function feesOf(event) {
  var member = event.getInt("member_fee");
  return { entry_fee: Math.max(0, event.getInt("entry_fee")), member_fee: member > 0 ? member : null };
}

/** A booking record's times for the shared `liveWindow`. */
function timesOf(booking) {
  return {
    status: booking.getString("status"),
    starts_at: iso(booking.getString("starts_at")),
    ends_at: iso(booking.getString("ends_at")),
    checked_in_at: iso(booking.getString("checked_in_at")) || null,
    checked_out_at: iso(booking.getString("checked_out_at")) || null,
  };
}

// ---------------------------------------------------------------------
// What is busy
// ---------------------------------------------------------------------

/**
 * Live bookings of these resources that could touch [from, to): held,
 * confirmed or checked in and overlapping it, plus every session still
 * running that started before `to`, whose end nobody knows yet.
 */
function liveBookings(app, resourceIds, from, to, excludeId) {
  if (!resourceIds.length) return [];
  var params = { from: pbDate(from), to: pbDate(to) };
  var filter =
    "kind = 'resource' && " +
    anyOf("resource", resourceIds, "r", params) +
    " && (((status = 'held' || status = 'confirmed' || status = 'checked_in') && starts_at < {:to} && ends_at > {:from})" +
    " || (status = 'checked_in' && checked_out_at = '' && starts_at < {:to}))";
  if (excludeId) {
    filter += " && id != {:exclude}";
    params.exclude = excludeId;
  }
  return findAll(app, "bookings", filter, "starts_at", params);
}

/** Published events taking any of these resources and overlapping [from, to). */
function eventsTaking(app, resourceIds, from, to, excludeEventId) {
  if (!resourceIds.length) return [];
  var params = { from: pbDate(from), to: pbDate(to) };
  // A multiple relation matches one of its ids through `resources.id ?=`;
  // a bare `resources ?=` compares the whole list and never matches.
  var filter =
    "status = 'published' && starts_at < {:to} && ends_at > {:from} && " + anyOf("resources.id", resourceIds, "r", params, "?=");
  if (excludeEventId) {
    filter += " && id != {:exclude}";
    params.exclude = excludeEventId;
  }
  return findAll(app, "booking_events", filter, "starts_at", params);
}

/**
 * Every busy window of these resources in [from, to), by resource id: their
 * live bookings (a running session to the end of the slot it is in, through
 * the shared `liveWindow`) and the published events that take them.
 */
function busyByResource(app, shapes, from, to, now, opts) {
  opts = opts || {};
  var b = shared();
  var ids = [];
  var slotOf = {};
  var out = {};
  for (var i = 0; i < shapes.length; i++) {
    ids.push(shapes[i].id);
    slotOf[shapes[i].id] = shapes[i].slot_minutes;
    out[shapes[i].id] = [];
  }
  var bookings = liveBookings(app, ids, from, to, opts.excludeBooking);
  for (var j = 0; j < bookings.length; j++) {
    var rid = bookings[j].getString("resource");
    var window = b.liveWindow(timesOf(bookings[j]), slotOf[rid] || 60, now);
    if (window && out[rid]) out[rid].push(window);
  }
  var events = eventsTaking(app, ids, from, to, opts.excludeEvent);
  for (var k = 0; k < events.length; k++) {
    var window2 = { starts_at: iso(events[k].getString("starts_at")), ends_at: iso(events[k].getString("ends_at")) };
    var taken = idsOf(events[k], "resources");
    for (var t = 0; t < taken.length; t++) {
      if (out[taken[t]]) out[taken[t]].push(window2);
    }
  }
  return out;
}

/** One resource's busy windows around a window. */
function busyFor(app, shape, window, now, excludeId) {
  var from = new Date(window.starts_at);
  var to = new Date(window.ends_at);
  return busyByResource(app, [shape], from, to, now, { excludeBooking: excludeId })[shape.id] || [];
}

/**
 * Why a resource cannot be booked for a window, or null: the shared
 * `bookingProblem`, its hours and slot refusals as 400 (409 for a switched
 * off resource), and a clash as 409 with the contract's sentence. Reads with
 * the app it is given, so a transaction sees its own writes.
 */
function placeProblem(app, shape, window, now, excludeId) {
  var b = shared();
  var hours = shopHours(app);
  var basic = b.bookingProblem(shape, hours, window, []);
  if (basic) return refusal(shape.active ? 400 : 409, basic);
  var clash = b.bookingProblem(shape, hours, window, busyFor(app, shape, window, now, excludeId));
  return clash ? refusal(409, clash) : null;
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

/**
 * `Availability` for one shop day: every active resource (only the `online`
 * ones for the public route), of a kind when one is given, that seats the
 * party, with the shared `daySlots`. The public answer also marks a slot
 * that has started as not free; staff see the whole day as it is.
 */
function availability(app, opts) {
  var b = shared();
  var params = {};
  var filter = "active = true";
  if (opts.kind) {
    filter += " && kind = {:kind}";
    params.kind = opts.kind;
  }
  if (opts.publicOnly) filter += " && online = true";
  var records = findAll(app, "resources", filter, "sort,name", params);
  var shapes = [];
  for (var i = 0; i < records.length; i++) {
    var shape = resourceShape(records[i]);
    if (opts.party > 0 && shape.capacity > 0 && opts.party > shape.capacity) continue;
    shapes.push(shape);
  }
  var bounds = b.shopDayBounds(opts.date);
  var busy = busyByResource(app, shapes, new Date(bounds.starts_at), new Date(bounds.ends_at), opts.now);
  var hours = shopHours(app);
  var out = [];
  for (var j = 0; j < shapes.length; j++) {
    out.push({
      resource: resourceSummary(shapes[j]),
      slots: b.daySlots(shapes[j], hours, opts.date, busy[shapes[j].id] || [], opts.publicOnly ? opts.now : undefined),
    });
  }
  return { date: opts.date, resources: out };
}

// ---------------------------------------------------------------------
// Events: entries, places and the waitlist
// ---------------------------------------------------------------------

/** An event's entries that hold or wait for a place: held, confirmed, checked in or completed. */
function eventEntries(app, eventId) {
  return findAll(
    app,
    "bookings",
    "event = {:event} && kind = 'event' && (status = 'held' || status = 'confirmed' || status = 'checked_in' || status = 'completed')",
    "created,id",
    { event: eventId }
  );
}

function entryShapes(entries) {
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    out.push({
      id: entries[i].id,
      party_size: Math.max(1, entries[i].getInt("party_size")),
      status: entries[i].getString("status"),
      created: iso(entries[i].getString("created")),
    });
  }
  return out;
}

/** The shared `waitlistOf` for an event, from the app it is given. */
function waitlistFor(app, event) {
  return shared().waitlistOf(Math.max(0, event.getInt("capacity")), entryShapes(eventEntries(app, event.id)));
}

/** Places left for a new entry, or null when there is no limit. */
function placesFor(app, event) {
  var left = shared().placesLeft(Math.max(0, event.getInt("capacity")), entryShapes(eventEntries(app, event.id)));
  return isFinite(left) ? left : null;
}

/**
 * Tell each entry that has just come off an event's waitlist that a place
 * is held for them: `before` is the waitlist as it stood, read again here
 * with the app the change was written through. Returns the pending emails.
 */
function offerPlaces(app, event, before) {
  var notifyLib = require(__hooks + "/lib/notify.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var after = waitlistFor(app, event);
  var still = {};
  for (var i = 0; i < after.length; i++) still[after[i]] = true;
  var pending = [];
  for (var j = 0; j < before.length; j++) {
    if (still[before[j]]) continue;
    var entry = findById(app, "bookings", before[j]);
    if (!entry || entry.getString("status") !== "held" || !entry.getString("customer")) continue;
    var owed = Math.max(0, entry.getInt("price") - entry.getInt("paid"));
    var name = event.getString("name");
    var n = notifyLib.notify(app, {
      customer: entry.getString("customer"),
      type: "booking_place",
      title: "A place has come up at " + name,
      body:
        "A place has come up at " +
        name +
        " on " +
        dayLabel(iso(event.getString("starts_at"))) +
        ". It is held for you" +
        (owed > 0 ? ": pay " + money.formatGBP(owed) + " at the till to keep it." : "."),
      link: "/account/bookings",
      email: true,
    });
    pending = pending.concat(n.pending || []);
  }
  return pending;
}

// ---------------------------------------------------------------------
// What the routes answer
// ---------------------------------------------------------------------

/**
 * `BookingView`s for a list of booking records, with the resources, events
 * and customers they name read in one query each. `opts.forCustomer` leaves
 * the staff note out.
 */
function views(app, records, opts) {
  opts = opts || {};
  var resourceIds = [];
  var eventIds = [];
  var customerIds = [];
  for (var i = 0; i < records.length; i++) {
    resourceIds.push(records[i].getString("resource"));
    eventIds.push(records[i].getString("event"));
    customerIds.push(records[i].getString("customer"));
  }
  var resources = byIds(app, "resources", resourceIds);
  var events = byIds(app, "booking_events", eventIds);
  var customers = byIds(app, "customers", customerIds);

  // Waitlist positions, one read of each event's entries.
  var positions = {};
  for (var id in events) {
    var waiting = waitlistFor(app, events[id]);
    for (var w = 0; w < waiting.length; w++) positions[waiting[w]] = w + 1;
  }

  var out = [];
  for (var j = 0; j < records.length; j++) {
    var r = records[j];
    var res = resources[r.getString("resource")] || null;
    var ev = events[r.getString("event")] || null;
    var cust = customers[r.getString("customer")] || null;
    var price = r.getInt("price");
    var paid = r.getInt("paid");
    out.push({
      id: r.id,
      kind: r.getString("kind"),
      resource: res ? { id: res.id, name: res.getString("name"), kind: res.getString("kind") } : null,
      event: ev ? { id: ev.id, name: ev.getString("name") } : null,
      customer: cust
        ? { id: cust.id, name: cust.getString("name"), code: cust.getString("code"), member: isMember(cust) }
        : null,
      name: cust ? cust.getString("name") : r.getString("name"),
      phone: r.getString("phone") || (cust ? cust.getString("phone") : ""),
      email: r.getString("email") || (cust ? cust.getString("email") : ""),
      starts_at: iso(r.getString("starts_at")),
      ends_at: iso(r.getString("ends_at")),
      party_size: Math.max(1, r.getInt("party_size")),
      status: r.getString("status"),
      price: price,
      deposit: r.getInt("deposit"),
      paid: paid,
      balance: Math.max(0, price - paid),
      source: r.getString("source"),
      checked_in_at: iso(r.getString("checked_in_at")) || null,
      checked_out_at: iso(r.getString("checked_out_at")) || null,
      waitlist_position: positions[r.id] || null,
      notes: opts.forCustomer ? "" : r.getString("notes"),
      created: iso(r.getString("created")),
    });
  }
  return out;
}

function view(app, record, opts) {
  return views(app, [record], opts)[0];
}

/**
 * The sale lines that paid towards a booking and are not refunded in full,
 * oldest first, each with the pence of the booking's price it still settles
 * (its unit price for every unit not refunded).
 */
function payments(app, bookingId) {
  var lines = findAll(app, "sale_lines", "booking = {:booking} && status != 'refunded'", "created,id", {
    booking: bookingId,
  });
  var saleIds = [];
  for (var i = 0; i < lines.length; i++) saleIds.push(lines[i].getString("sale"));
  var sales = byIds(app, "sales", saleIds);
  var out = [];
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    var sale = sales[line.getString("sale")];
    var units = Math.max(0, line.getInt("qty") - line.getInt("refunded_qty"));
    if (!sale || units <= 0) continue;
    out.push({
      sale: { id: sale.id, number: sale.getString("number") },
      sale_line: line.id,
      amount: line.getInt("unit_price") * units,
      units: units,
    });
  }
  return out;
}

/** `EventView`s, with their resources and games read once. */
function eventViews(app, records) {
  var resourceIds = [];
  var gameIds = [];
  for (var i = 0; i < records.length; i++) {
    resourceIds = resourceIds.concat(idsOf(records[i], "resources"));
    gameIds.push(records[i].getString("game"));
  }
  var resources = byIds(app, "resources", resourceIds);
  var games = byIds(app, "games", gameIds);
  var out = [];
  for (var j = 0; j < records.length; j++) {
    var ev = records[j];
    var entries = entryShapes(eventEntries(app, ev.id));
    var capacity = Math.max(0, ev.getInt("capacity"));
    var waiting = shared().waitlistOf(capacity, entries);
    var waitSet = {};
    for (var w = 0; w < waiting.length; w++) waitSet[waiting[w]] = true;
    var entered = 0;
    for (var k = 0; k < entries.length; k++) {
      if (!waitSet[entries[k].id]) entered += entries[k].party_size;
    }
    var left = shared().placesLeft(capacity, entries);
    var taken = idsOf(ev, "resources");
    var list = [];
    for (var t = 0; t < taken.length; t++) {
      var res = resources[taken[t]];
      if (res) list.push({ id: res.id, name: res.getString("name"), kind: res.getString("kind") });
    }
    var game = games[ev.getString("game")] || null;
    var fees = feesOf(ev);
    out.push({
      id: ev.id,
      name: ev.getString("name"),
      game: game ? { id: game.id, name: game.getString("name") } : null,
      format: ev.getString("format"),
      starts_at: iso(ev.getString("starts_at")),
      ends_at: iso(ev.getString("ends_at")),
      capacity: capacity,
      places_left: isFinite(left) ? left : null,
      entry_fee: fees.entry_fee,
      member_fee: fees.member_fee,
      online: ev.getBool("online"),
      status: ev.getString("status"),
      repeat_weekly: ev.getBool("repeat_weekly"),
      repeat_of: ev.getString("repeat_of") || null,
      resources: list,
      description: ev.getString("description"),
      entered: entered,
      waitlist: waiting.length,
    });
  }
  return out;
}

/** "Table 2, Fri 16 Oct 18:00" or "Pokémon League, Fri 16 Oct": how a booking is named on a ticket and in messages. */
function label(app, booking) {
  var b = shared();
  var start = iso(booking.getString("starts_at"));
  if (booking.getString("kind") === "event") {
    var ev = findById(app, "booking_events", booking.getString("event"));
    return (ev ? ev.getString("name") : "Event entry") + ", " + dayLabel(start);
  }
  var res = findById(app, "resources", booking.getString("resource"));
  return (res ? res.getString("name") : "Booking") + ", " + dayLabel(start) + " " + b.shopClock(start);
}

// ---------------------------------------------------------------------
// Refusals by status
// ---------------------------------------------------------------------

/** The sentence for a booking that is not in a state an action can start from. */
function statusRefusal(status) {
  if (status === "cancelled") return refusal(409, "This booking is cancelled.");
  if (status === "no_show") return refusal(409, "This booking was a no-show.");
  if (status === "completed") return refusal(409, "This booking has finished.");
  if (status === "checked_in") return refusal(409, "This booking has checked in. Check it out first.");
  return refusal(409, "This booking cannot be changed now.");
}

/** Held or confirmed: a booking that has not started yet. */
function isOpen(booking) {
  var s = booking.getString("status");
  return s === "held" || s === "confirmed";
}

// ---------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------

/**
 * The checks on a new booking or event entry, before the transaction.
 *
 * input: the request body. ctx: { actor: "staff" | "customer", customer (the
 * signed-in customer's record, for "customer"), staffId, now }.
 *
 * A customer books for themselves only, an `online` resource or event only,
 * and only ahead of time; staff may book into the past (a walk-in that is
 * already sitting down). A member pays the member price. An event entry
 * past the places left is refused unless `waitlist` asks to wait; a staff
 * entry with `free_entry` uses one of the customer's tier's
 * `free_event_entries` and takes one player's fee off.
 *
 * Status: a waitlisted entry and an online booking with something to pay are
 * `held`; a staff booking with a deposit due is `held` until it is paid;
 * anything else is `confirmed`.
 */
function prepareCreate(app, input, ctx) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var b = shared();
  var now = ctx.now;
  var byCustomer = ctx.actor === "customer";

  var party = util.asInt(input.party_size, 1);
  if (party < 1) return refusal(400, "A booking is for 1 person or more.");

  var customer = null;
  var sentCustomer = util.asStr(input.customer);
  if (byCustomer) {
    if (sentCustomer && sentCustomer !== ctx.customer.id) {
      return refusal(403, "You can only book for yourself.");
    }
    customer = ctx.customer;
  } else if (sentCustomer) {
    customer = findById(app, "customers", sentCustomer);
    if (!customer) return refusal(404, "That customer was not found. Search again.");
  }

  var name = "";
  var phone = "";
  var email = "";
  if (!customer) {
    name = util.asStr(input.name).slice(0, 200);
    phone = util.asStr(input.phone);
    email = util.asStr(input.email).toLowerCase();
    if (!name) return refusal(400, "Add a name for the booking, or pick the customer.");
    if (phone.length > 32) return refusal(400, "That phone number is too long. Check it and try again.");
    if (email && !EMAIL.test(email)) return refusal(400, "That email address does not look right. Check it and try again.");
  }
  var member = isMember(customer);

  var source = byCustomer ? "online" : util.asStr(input.source) === "phone" ? "phone" : "till";
  var notes = byCustomer ? "" : util.asStr(input.notes).slice(0, 2000);

  var resourceId = util.asStr(input.resource);
  var eventId = util.asStr(input.event);
  if (resourceId && eventId) return refusal(400, "Book a table, station or room, or enter an event, not both.");
  if (!resourceId && !eventId) return refusal(400, "Pick a table, station or room, or an event.");

  var base = {
    customer: customer,
    name: name,
    phone: phone,
    email: email,
    party: party,
    member: member,
    source: source,
    notes: notes,
    byCustomer: byCustomer,
  };

  if (resourceId) {
    var record = findById(app, "resources", resourceId);
    if (!record) return refusal(404, "That table, station or room was not found. Reload the bookings.");
    var shape = resourceShape(record);
    if (byCustomer && (!shape.online || !shape.active)) {
      return refusal(403, shape.name + " cannot be booked online. Ring the shop to book it.");
    }
    var start = instant(input.starts_at);
    var end = instant(input.ends_at);
    if (!start || !end) return refusal(400, "Send the start and end of the booking.");
    var window = { starts_at: start.toISOString(), ends_at: end.toISOString() };
    if (byCustomer && start.getTime() <= now.getTime()) {
      return refusal(400, "That time has passed. Pick a later slot.");
    }
    if (shape.capacity > 0 && party > shape.capacity) {
      return refusal(400, shape.name + " takes up to " + shape.capacity + ". Pick a bigger one or split the party.");
    }
    var problem = placeProblem(app, shape, window, now, "");
    if (problem) return problem;
    var priced = b.bookingPrice(shape, window, member);
    var status = byCustomer ? (priced.price > 0 ? "held" : "confirmed") : priced.deposit > 0 ? "held" : "confirmed";
    return {
      ok: true,
      plan: Object.assign(base, {
        kind: "resource",
        resource: shape,
        window: window,
        price: priced.price,
        deposit: priced.deposit,
        slots: priced.slots,
        status: status,
      }),
    };
  }

  var event = findById(app, "booking_events", eventId);
  if (!event || (byCustomer && event.getString("status") === "draft")) {
    return refusal(404, "That event was not found. Reload the events.");
  }
  var eventName = event.getString("name");
  var problemOfEvent = entryProblem(event, now, byCustomer);
  if (problemOfEvent) return problemOfEvent;

  if (customer) {
    var already = findAll(
      app,
      "bookings",
      "event = {:event} && customer = {:customer} && (status = 'held' || status = 'confirmed' || status = 'checked_in' || status = 'completed')",
      "",
      { event: event.id, customer: customer.id }
    );
    if (already.length) {
      return refusal(
        409,
        byCustomer ? "You are already entered in " + eventName + "." : customer.getString("name") + " is already entered in " + eventName + "."
      );
    }
  }

  var waiting = false;
  var left = placesFor(app, event);
  if (left !== null && party > left) {
    if (!util.asBool(input.waitlist)) return fullRefusal(eventName, left, byCustomer);
    waiting = true;
  }

  var fee = b.entryFee(feesOf(event), member);
  var price = fee * party;
  var freeEntry = !byCustomer && util.asBool(input.free_entry);
  var tier = null;
  if (freeEntry) {
    if (!customer) return refusal(400, "Pick the customer to use their free entry.");
    if (waiting) return refusal(409, "Use a free entry once they have a place, not on the waitlist.");
    tier = tierOf(app, customer.id);
    var perks = require(__hooks + "/lib/perks.js");
    var perkRefusal = perks.check(app, customer.id, tier, "free_event_entries", 1, now);
    if (perkRefusal) return refusal(perkRefusal.status, perkRefusal.message);
    price = Math.max(0, price - fee);
  }

  return {
    ok: true,
    plan: Object.assign(base, {
      kind: "event",
      event: event,
      window: { starts_at: iso(event.getString("starts_at")), ends_at: iso(event.getString("ends_at")) },
      price: price,
      deposit: 0,
      status: waiting ? "held" : byCustomer && price > 0 ? "held" : "confirmed",
      waiting: waiting,
      freeEntry: freeEntry,
      tier: tier,
    }),
  };
}

/** Why an event takes no entries now, or null. */
function entryProblem(event, now, byCustomer) {
  var name = event.getString("name");
  var status = event.getString("status");
  if (status === "draft") return refusal(409, name + " is not published yet. Publish it before taking entries.");
  if (status === "cancelled") return refusal(409, name + " is cancelled.");
  if (status === "finished") return refusal(409, name + " has finished.");
  if (byCustomer && !event.getBool("online")) {
    return refusal(403, name + " takes entries at the counter. Ring the shop to enter.");
  }
  var start = Date.parse(iso(event.getString("starts_at")));
  var end = Date.parse(iso(event.getString("ends_at")));
  if (byCustomer && start <= now.getTime()) return refusal(409, name + " has already started.");
  if (end <= now.getTime()) return refusal(409, name + " has finished.");
  return null;
}

/** An event with fewer places than the party, worded for who is asking. */
function fullRefusal(eventName, left, byCustomer) {
  var wait = byCustomer ? "join the waitlist" : "add them to the waitlist";
  if (left <= 0) return refusal(409, eventName + " is full. " + (byCustomer ? "Join" : "Add them to") + " the waitlist instead.");
  return refusal(
    409,
    eventName + " has " + left + (left === 1 ? " place" : " places") + " left. Make the party smaller or " + wait + "."
  );
}

/** A customer's tier in the shape lib/perks.js takes, or null. */
function tierOf(app, customerId) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var priv = null;
  try {
    priv = app.findFirstRecordByFilter("customer_private", "customer = {:c}", { c: customerId });
  } catch (err) {
    priv = null;
  }
  return priv ? util.tier(app, priv.getString("tier")) : null;
}

/**
 * The booking itself, inside the caller's transaction: the overlap (a
 * resource) or the places and the duplicate (an event) checked again with
 * the transaction's own reads, the free entry used, the record, its audit
 * row and, for a customer's own online booking, their confirmation. Returns
 * { ok: true, record, pending } or a refusal for the route's `halt`.
 */
function writeCreate(txApp, plan, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var notifyLib = require(__hooks + "/lib/notify.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var b = shared();
  var now = ctx.now;
  var perkPeriod = "";

  if (plan.kind === "resource") {
    var live = findById(txApp, "resources", plan.resource.id);
    if (!live) return refusal(404, "That table, station or room was not found. Reload the bookings.");
    var problem = placeProblem(txApp, resourceShape(live), plan.window, now, "");
    if (problem) return problem;
  } else {
    var event = findById(txApp, "booking_events", plan.event.id);
    if (!event) return refusal(404, "That event was not found. Reload the events.");
    var eventProblem = entryProblem(event, now, plan.byCustomer);
    if (eventProblem) return eventProblem;
    if (plan.customer) {
      var already = findAll(
        txApp,
        "bookings",
        "event = {:event} && customer = {:customer} && (status = 'held' || status = 'confirmed' || status = 'checked_in' || status = 'completed')",
        "",
        { event: event.id, customer: plan.customer.id }
      );
      if (already.length) {
        return refusal(
          409,
          plan.byCustomer
            ? "You are already entered in " + event.getString("name") + "."
            : plan.customer.getString("name") + " is already entered in " + event.getString("name") + "."
        );
      }
    }
    if (!plan.waiting) {
      var left = placesFor(txApp, event);
      if (left !== null && plan.party > left) return fullRefusal(event.getString("name"), left, plan.byCustomer);
    }
    if (plan.freeEntry) {
      var perks = require(__hooks + "/lib/perks.js");
      var used = perks.use(txApp, plan.customer.id, plan.tier, "free_event_entries", 1, now);
      if (!used.ok) return refusal(used.status, used.message);
      perkPeriod = used.entry.period;
    }
  }

  var record = new Record(txApp.findCollectionByNameOrId("bookings"), {
    kind: plan.kind,
    starts_at: plan.window.starts_at,
    ends_at: plan.window.ends_at,
    party_size: plan.party,
    status: plan.status,
    price: plan.price,
    deposit: plan.deposit,
    paid: 0,
    source: plan.source,
    notes: plan.notes,
  });
  if (plan.kind === "resource") record.set("resource", plan.resource.id);
  else record.set("event", plan.event.id);
  if (plan.customer) {
    record.set("customer", plan.customer.id);
  } else {
    record.set("name", plan.name);
    if (plan.phone) record.set("phone", plan.phone);
    if (plan.email) record.set("email", plan.email);
  }
  if (ctx.staffId) record.set("created_by", ctx.staffId);
  txApp.save(record);

  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId || (plan.customer ? plan.customer.id : ""),
    action: "booking_create",
    collection: "bookings",
    record: record.id,
    meta: {
      kind: plan.kind,
      resource: plan.kind === "resource" ? plan.resource.id : "",
      event: plan.kind === "event" ? plan.event.id : "",
      customer: plan.customer ? plan.customer.id : "",
      starts_at: plan.window.starts_at,
      ends_at: plan.window.ends_at,
      party_size: plan.party,
      status: plan.status,
      price: plan.price,
      deposit: plan.deposit,
      member: plan.member,
      source: plan.source,
      waitlist: !!plan.waiting,
      free_entry: !!plan.freeEntry,
      perk_period: perkPeriod,
      by: plan.byCustomer ? "customer" : "staff",
    },
    ip: ctx.ip,
  });

  // A customer's own online booking or entry is confirmed back to them, so
  // they know it is held and what to pay at the till.
  var pending = [];
  if (plan.byCustomer) {
    var what =
      plan.kind === "resource"
        ? plan.resource.name +
          " is " +
          (plan.status === "held" ? "held" : "booked") +
          " for you on " +
          dayLabel(plan.window.starts_at) +
          ", " +
          b.shopClock(plan.window.starts_at) +
          " to " +
          b.shopClock(plan.window.ends_at) +
          "."
        : plan.waiting
          ? "You are on the waitlist for " + plan.event.getString("name") + " on " + dayLabel(plan.window.starts_at) + ". We will tell you if a place comes up."
          : "You are entered in " + plan.event.getString("name") + " on " + dayLabel(plan.window.starts_at) + ", from " + b.shopClock(plan.window.starts_at) + ".";
    var pay = !plan.waiting && plan.price > 0 ? " Pay " + money.formatGBP(plan.price) + " at the till when you arrive." : "";
    var n = notifyLib.notify(txApp, {
      customer: plan.customer.id,
      type: "booking_made",
      title: plan.waiting ? "You are on the waitlist" : plan.kind === "event" ? "You are entered" : "Your booking",
      body: what + pay,
      link: "/account/bookings",
      email: true,
    });
    pending = n.pending || [];
  }

  return { ok: true, record: record, pending: pending };
}

// ---------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------

/**
 * The checks on moving a booking to another time and, optionally, another
 * resource: a resource booking that has not started, the new window clear of
 * everything but itself, repriced for the new length and resource, and never
 * below what has been paid.
 */
function prepareMove(app, booking, input, now) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var b = shared();
  if (booking.getString("kind") === "event") {
    return refusal(400, "An event entry moves with its event. Cancel it and enter another event instead.");
  }
  if (!isOpen(booking)) return statusRefusal(booking.getString("status"));

  var resourceId = util.asStr(input.resource) || booking.getString("resource");
  var record = findById(app, "resources", resourceId);
  if (!record) return refusal(404, "That table, station or room was not found. Reload the bookings.");
  var shape = resourceShape(record);
  var start = instant(input.starts_at);
  var end = instant(input.ends_at);
  if (!start || !end) return refusal(400, "Send the new start and end of the booking.");
  var window = { starts_at: start.toISOString(), ends_at: end.toISOString() };
  var party = Math.max(1, booking.getInt("party_size"));
  if (shape.capacity > 0 && party > shape.capacity) {
    return refusal(400, shape.name + " takes up to " + shape.capacity + ". Pick a bigger one or split the party.");
  }
  var problem = placeProblem(app, shape, window, now, booking.id);
  if (problem) return problem;

  var customer = findById(app, "customers", booking.getString("customer"));
  var priced = b.bookingPrice(shape, window, isMember(customer));
  var paid = booking.getInt("paid");
  if (priced.price < paid) {
    return refusal(
      409,
      "This booking has " +
        money.formatGBP(paid) +
        " paid, more than its new price of " +
        money.formatGBP(priced.price) +
        ". Keep it as long, or refund it first."
    );
  }
  return { ok: true, plan: { booking: booking, resource: shape, window: window, price: priced.price, deposit: priced.deposit } };
}

/** The move inside the caller's transaction, re-checked against the live booking and what is busy. */
function writeMove(txApp, plan, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var live = findById(txApp, "bookings", plan.booking.id);
  if (!live) return refusal(404, "That booking was not found. Reload the bookings.");
  if (!isOpen(live)) return statusRefusal(live.getString("status"));
  var problem = placeProblem(txApp, plan.resource, plan.window, ctx.now, live.id);
  if (problem) return problem;
  if (plan.price < live.getInt("paid")) {
    return refusal(409, "This booking was paid for while it was being moved. Reload it and try again.");
  }
  var from = {
    resource: live.getString("resource"),
    starts_at: iso(live.getString("starts_at")),
    ends_at: iso(live.getString("ends_at")),
    price: live.getInt("price"),
  };
  live.set("resource", plan.resource.id);
  live.set("starts_at", plan.window.starts_at);
  live.set("ends_at", plan.window.ends_at);
  live.set("price", plan.price);
  live.set("deposit", plan.deposit);
  txApp.save(live);
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: "booking_move",
    collection: "bookings",
    record: live.id,
    meta: {
      from: from,
      to: { resource: plan.resource.id, starts_at: plan.window.starts_at, ends_at: plan.window.ends_at, price: plan.price },
    },
    ip: ctx.ip,
  });
  return { ok: true, record: live };
}

// ---------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------

/**
 * The lines the till refunds when a booking is cancelled. Everything paid
 * goes back unless the deposit is kept; with the deposit kept, what was paid
 * past the deposit goes back, as whole lines, newest first, so a line that
 * paid part of the deposit stays. Returns { refunds: BookingRefund[], kept }.
 */
function refundsFor(app, booking, keepDeposit) {
  var paid = booking.getInt("paid");
  var due = keepDeposit ? Math.max(0, paid - Math.min(booking.getInt("deposit"), paid)) : paid;
  var list = payments(app, booking.id);
  var chosen = [];
  for (var i = list.length - 1; i >= 0 && due > 0; i--) {
    if (list[i].amount <= due) {
      chosen.unshift(list[i]);
      due -= list[i].amount;
    }
  }
  var bySale = {};
  var order = [];
  var back = 0;
  for (var j = 0; j < chosen.length; j++) {
    var p = chosen[j];
    if (!bySale[p.sale.id]) {
      bySale[p.sale.id] = { sale: p.sale, lines: [], amount: 0 };
      order.push(p.sale.id);
    }
    bySale[p.sale.id].lines.push({ sale_line: p.sale_line, qty: p.units });
    bySale[p.sale.id].amount += p.amount;
    back += p.amount;
  }
  var refunds = [];
  for (var k = 0; k < order.length; k++) refunds.push(bySale[order[k]]);
  return { refunds: refunds, kept: Math.max(0, paid - back) };
}

/**
 * The checks on cancelling. A customer cancels their own booking that has
 * not started and has nothing paid on it (money paid goes back at the till,
 * so the shop does it); staff cancel any held or confirmed booking.
 */
function prepareCancel(app, booking, input, ctx) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var money = require(__hooks + "/lib/shared/money.js");
  if (!isOpen(booking)) return statusRefusal(booking.getString("status"));
  if (ctx.actor === "customer") {
    if (Date.parse(iso(booking.getString("starts_at"))) <= ctx.now.getTime()) {
      return refusal(409, "This booking has started. Ring the shop to change it.");
    }
    if (booking.getInt("paid") > 0) {
      return refusal(
        409,
        "This booking has " + money.formatGBP(booking.getInt("paid")) + " paid. Ring the shop to cancel it, so it can be refunded."
      );
    }
    return { ok: true, plan: { booking: booking, keepDeposit: true, refunds: [], kept: 0 } };
  }
  var keep = util.asBool(input.keep_deposit);
  var planned = refundsFor(app, booking, keep);
  return { ok: true, plan: { booking: booking, keepDeposit: keep, refunds: planned.refunds, kept: planned.kept } };
}

/**
 * The cancellation inside the caller's transaction: the booking cancelled, a
 * free entry it used given back when it was this month's, the waitlist
 * offered the place it frees, the customer told when staff cancelled it,
 * and the audit row with the refunds the till is to make.
 */
function writeCancel(txApp, plan, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var notifyLib = require(__hooks + "/lib/notify.js");
  var live = findById(txApp, "bookings", plan.booking.id);
  if (!live) return refusal(404, "That booking was not found. Reload the bookings.");
  if (!isOpen(live)) return statusRefusal(live.getString("status"));
  if (live.getInt("paid") !== plan.booking.getInt("paid")) {
    return refusal(409, "This booking was paid for while it was being cancelled. Reload it and try again.");
  }

  var event = live.getString("kind") === "event" ? findById(txApp, "booking_events", live.getString("event")) : null;
  var before = event ? waitlistFor(txApp, event) : [];

  live.set("status", "cancelled");
  txApp.save(live);

  var perkBack = giveBackFreeEntry(txApp, live, ctx.now);

  var pending = [];
  if (event) pending = pending.concat(offerPlaces(txApp, event, before));
  if (ctx.actor === "staff" && live.getString("customer")) {
    var n = notifyLib.notify(txApp, {
      customer: live.getString("customer"),
      type: "booking_cancelled",
      title: "Your booking is cancelled",
      body: "Your booking for " + label(txApp, live) + " is cancelled. Ring the shop if that is not right.",
      link: "/account/bookings",
      email: true,
    });
    pending = pending.concat(n.pending || []);
  }

  auditLib.writeAuditLog(txApp, {
    actor: ctx.actor === "staff" ? ctx.staffId : live.getString("customer"),
    action: "booking_cancel",
    collection: "bookings",
    record: live.id,
    meta: {
      by: ctx.actor,
      keep_deposit: plan.keepDeposit,
      paid: live.getInt("paid"),
      kept: plan.kept,
      refunds: plan.refunds,
      free_entry_back: perkBack,
    },
    ip: ctx.ip,
  });
  return { ok: true, record: live, pending: pending };
}

/**
 * A cancelled entry that used a free entry this month gives it back: the
 * booking's own `booking_create` audit row says whether it used one and in
 * which month. A free entry from an earlier month is gone with that month.
 */
function giveBackFreeEntry(txApp, booking, now) {
  if (booking.getString("kind") !== "event" || !booking.getString("customer")) return false;
  var util = require(__hooks + "/lib/vaultutil.js");
  var perks = require(__hooks + "/lib/perks.js");
  var row = null;
  try {
    row = txApp.findFirstRecordByFilter("audit_log", "action = 'booking_create' && record = {:id}", { id: booking.id });
  } catch (err) {
    row = null;
  }
  if (!row) return false;
  var meta = util.jsonField(row, "meta", {}) || {};
  if (!meta.free_entry || meta.perk_period !== perks.currentPeriod(now)) return false;
  var usage = perks.usageRow(txApp, booking.getString("customer"), "free_event_entries", meta.perk_period);
  if (!usage || usage.getInt("used_count") < 1) return false;
  usage.set("used_count", usage.getInt("used_count") - 1);
  txApp.save(usage);
  return true;
}

// ---------------------------------------------------------------------
// No-show, check-in, check-out
// ---------------------------------------------------------------------

/** The checks on a no-show: a held or confirmed booking whose start has passed. */
function noShowProblem(booking, now) {
  if (!isOpen(booking)) return statusRefusal(booking.getString("status"));
  if (Date.parse(iso(booking.getString("starts_at"))) > now.getTime()) {
    return refusal(409, "This booking has not started yet. Cancel it instead.");
  }
  return null;
}

/**
 * The checks on a check-in: a held or confirmed booking for today, shop
 * time, and not an entry still on its event's waitlist.
 */
function checkInProblem(app, booking, now) {
  var b = shared();
  if (booking.getString("status") === "checked_in") return refusal(409, "This booking is already checked in.");
  if (!isOpen(booking)) return statusRefusal(booking.getString("status"));
  var start = iso(booking.getString("starts_at"));
  if (b.shopDateOf(new Date(start)) > b.shopDateOf(now)) {
    return refusal(409, "This booking is for " + dayLabel(start) + ". Check it in on the day.");
  }
  if (booking.getString("kind") === "event") {
    var event = findById(app, "booking_events", booking.getString("event"));
    if (event && waitlistFor(app, event).indexOf(booking.id) >= 0) {
      return refusal(409, "That entry is on the waitlist. Check them in when a place frees.");
    }
  }
  return null;
}

/**
 * A status change inside the caller's transaction (no-show or check-in),
 * re-checked against the live booking, with its audit row. A no-show frees
 * an event place, so the waitlist is offered it.
 */
function setStatus(txApp, bookingId, to, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var live = findById(txApp, "bookings", bookingId);
  if (!live) return refusal(404, "That booking was not found. Reload the bookings.");
  var problem = to === "checked_in" ? checkInProblem(txApp, live, ctx.now) : noShowProblem(live, ctx.now);
  if (problem) return problem;
  var event = live.getString("kind") === "event" ? findById(txApp, "booking_events", live.getString("event")) : null;
  var before = event && to === "no_show" ? waitlistFor(txApp, event) : [];
  var from = live.getString("status");
  live.set("status", to);
  if (to === "checked_in") live.set("checked_in_at", ctx.now.toISOString());
  txApp.save(live);
  var pending = event && to === "no_show" ? offerPlaces(txApp, event, before) : [];
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: to === "checked_in" ? "booking_check_in" : "booking_no_show",
    collection: "bookings",
    record: live.id,
    meta: { from: from, to: to, deposit: live.getInt("deposit"), paid: live.getInt("paid"), via: ctx.via || "" },
    ip: ctx.ip,
  });
  return { ok: true, record: live, pending: pending };
}

/**
 * Check out, inside the caller's transaction. A PC or console station runs
 * on the clock: the shared `sessionCharge` from check-in to now (members at
 * the member price, a part slot counting once past the grace minutes), never
 * less than it was booked for, and its end moves out to now when it ran
 * over. A table, room or event entry keeps its price. Returns the booking
 * and `charge` ({ minutes, slots, price, balance }) for the till.
 */
function checkOut(txApp, bookingId, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var b = shared();
  var live = findById(txApp, "bookings", bookingId);
  if (!live) return refusal(404, "That booking was not found. Reload the bookings.");
  var status = live.getString("status");
  if (status === "completed") return refusal(409, "This booking has already checked out.");
  if (status !== "checked_in") return refusal(409, "This booking has not checked in.");

  var now = ctx.now;
  var checkedIn = iso(live.getString("checked_in_at")) || iso(live.getString("starts_at"));
  var minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(checkedIn)) / 60000));
  var price = live.getInt("price");
  var slots = 0;
  var byClock = false;
  if (live.getString("kind") === "resource") {
    var record = findById(txApp, "resources", live.getString("resource"));
    var shape = record ? resourceShape(record) : null;
    var customer = findById(txApp, "customers", live.getString("customer"));
    if (shape && STATIONS.indexOf(shape.kind) >= 0) {
      var charge = b.sessionCharge(shape, checkedIn, now.toISOString(), isMember(customer));
      slots = charge.slots;
      if (charge.price > price) {
        price = charge.price;
        byClock = true;
      }
      if (Date.parse(iso(live.getString("ends_at"))) < now.getTime()) live.set("ends_at", now.toISOString());
    } else if (shape) {
      slots = b.bookingPrice(shape, { starts_at: iso(live.getString("starts_at")), ends_at: iso(live.getString("ends_at")) }, false).slots;
    }
  }
  live.set("status", "completed");
  live.set("checked_out_at", now.toISOString());
  live.set("price", price);
  txApp.save(live);
  var balance = Math.max(0, price - live.getInt("paid"));
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: "booking_check_out",
    collection: "bookings",
    record: live.id,
    meta: { minutes: minutes, slots: slots, price: price, by_clock: byClock, paid: live.getInt("paid"), balance: balance },
    ip: ctx.ip,
  });
  return { ok: true, record: live, charge: { minutes: minutes, slots: slots, price: price, balance: balance } };
}

// ---------------------------------------------------------------------
// Walk-in sessions
// ---------------------------------------------------------------------

/**
 * The checks on a walk-in session: an active PC or console station, a
 * customer or a name (a bare walk-in is "Walk-in"), the party within its
 * capacity, and nothing on it for its first slot from now.
 */
function prepareWalkIn(app, input, now) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var record = findById(app, "resources", util.asStr(input.resource));
  if (!record) return refusal(404, "That station was not found. Reload the bookings.");
  var shape = resourceShape(record);
  if (STATIONS.indexOf(shape.kind) < 0) {
    return refusal(400, "Walk-in sessions run on PC and console stations. Book a table or room instead.");
  }
  if (!shape.active) return refusal(409, shape.name + " is switched off. Pick another.");
  var customer = null;
  if (util.asStr(input.customer)) {
    customer = findById(app, "customers", util.asStr(input.customer));
    if (!customer) return refusal(404, "That customer was not found. Search again.");
  }
  var party = util.asInt(input.party_size, 1);
  if (party < 1) return refusal(400, "A booking is for 1 person or more.");
  if (shape.capacity > 0 && party > shape.capacity) {
    return refusal(400, shape.name + " takes up to " + shape.capacity + ". Pick a bigger one or split the party.");
  }
  var window = {
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + shape.slot_minutes * 60000).toISOString(),
  };
  var clash = shared().clashProblem(shape, window, busyFor(app, shape, window, now, ""));
  if (clash) return refusal(409, clash);
  return {
    ok: true,
    plan: {
      resource: shape,
      customer: customer,
      name: customer ? "" : util.asStr(input.name).slice(0, 200) || "Walk-in",
      party: party,
      window: window,
    },
  };
}

/** The session inside the caller's transaction: the clash checked again, then a booking checked in now. */
function writeWalkIn(txApp, plan, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var clash = shared().clashProblem(plan.resource, plan.window, busyFor(txApp, plan.resource, plan.window, ctx.now, ""));
  if (clash) return refusal(409, clash);
  var record = new Record(txApp.findCollectionByNameOrId("bookings"), {
    kind: "resource",
    resource: plan.resource.id,
    starts_at: plan.window.starts_at,
    ends_at: plan.window.ends_at,
    party_size: plan.party,
    status: "checked_in",
    price: 0,
    deposit: 0,
    paid: 0,
    source: "till",
    checked_in_at: plan.window.starts_at,
    created_by: ctx.staffId,
  });
  if (plan.customer) record.set("customer", plan.customer.id);
  else record.set("name", plan.name);
  txApp.save(record);
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: "booking_walk_in",
    collection: "bookings",
    record: record.id,
    meta: {
      resource: plan.resource.id,
      customer: plan.customer ? plan.customer.id : "",
      starts_at: plan.window.starts_at,
      party_size: plan.party,
    },
    ip: ctx.ip,
  });
  return { ok: true, record: record };
}

/**
 * The stations strip: every active PC and console station, its running
 * session (checked in, not out) and its next held or confirmed booking that
 * starts later today, shop time.
 */
function stations(app, now) {
  var b = shared();
  var records = findAll(app, "resources", "active = true && (kind = 'pc' || kind = 'console')", "sort,name");
  var ids = [];
  for (var i = 0; i < records.length; i++) ids.push(records[i].id);
  var running = {};
  var next = {};
  if (ids.length) {
    var p1 = {};
    var sessions = findAll(
      app,
      "bookings",
      "kind = 'resource' && status = 'checked_in' && checked_out_at = '' && " + anyOf("resource", ids, "r", p1),
      "-checked_in_at",
      p1
    );
    for (var s = 0; s < sessions.length; s++) {
      var rid = sessions[s].getString("resource");
      if (!running[rid]) running[rid] = sessions[s];
    }
    var end = b.shopDayBounds(b.shopDateOf(now)).ends_at;
    var p2 = { now: pbDate(now), end: pbDate(end) };
    var upcoming = findAll(
      app,
      "bookings",
      "kind = 'resource' && (status = 'held' || status = 'confirmed') && starts_at >= {:now} && starts_at < {:end} && " +
        anyOf("resource", ids, "r", p2),
      "starts_at",
      p2
    );
    for (var u = 0; u < upcoming.length; u++) {
      var rid2 = upcoming[u].getString("resource");
      if (!next[rid2]) next[rid2] = upcoming[u];
    }
  }
  var out = [];
  for (var j = 0; j < records.length; j++) {
    var shape = resourceShape(records[j]);
    out.push({
      resource: {
        id: shape.id,
        name: shape.name,
        kind: shape.kind,
        slot_minutes: shape.slot_minutes,
        price: shape.price,
        member_price: shape.member_price,
      },
      session: running[shape.id] ? view(app, running[shape.id]) : null,
      next: next[shape.id] ? view(app, next[shape.id]) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Events: check-in by QR, and cancelling one
// ---------------------------------------------------------------------

/**
 * The customer a scanned Guild card names: the QR's portal link
 * (".../c/<token>"), the bare token, or the customer's code as printed.
 */
function customerFromScan(app, input) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var id = util.asStr(input.customer);
  if (id) return findById(app, "customers", id);
  var raw = util.asStr(input.qr) || util.asStr(input.code);
  if (!raw) return null;
  var token = raw;
  var at = raw.lastIndexOf("/c/");
  if (at >= 0) token = raw.slice(at + 3).split(/[?#/]/)[0];
  var found = null;
  try {
    found = app.findFirstRecordByFilter("customers", "qr_token = {:t}", { t: token });
  } catch (err) {
    found = null;
  }
  if (found) return found;
  var code = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!code) return null;
  try {
    return app.findFirstRecordByFilter("customers", "code = {:c}", { c: code });
  } catch (err) {
    return null;
  }
}

/** A customer's held or confirmed entry at an event, or null. */
function entryOf(app, eventId, customerId) {
  var rows = findAll(
    app,
    "bookings",
    "event = {:event} && customer = {:customer} && kind = 'event' && (status = 'held' || status = 'confirmed' || status = 'checked_in')",
    "created",
    { event: eventId, customer: customerId }
  );
  return rows.length ? rows[0] : null;
}

/**
 * Cancel an event inside the caller's transaction: the event cancelled, every
 * live entry cancelled and its customer told, and the refunds the till is to
 * make for what was paid (all of it: the shop called it off). Returns
 * { ok, event, cancelled, refunds, pending }.
 */
function cancelEvent(txApp, eventId, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var notifyLib = require(__hooks + "/lib/notify.js");
  var event = findById(txApp, "booking_events", eventId);
  if (!event) return refusal(404, "That event was not found. Reload the events.");
  var name = event.getString("name");
  if (event.getString("status") === "cancelled") return refusal(409, name + " is already cancelled.");
  if (event.getString("status") === "finished") return refusal(409, name + " has finished.");
  event.set("status", "cancelled");
  txApp.save(event);

  var entries = findAll(
    txApp,
    "bookings",
    "event = {:event} && kind = 'event' && (status = 'held' || status = 'confirmed' || status = 'checked_in')",
    "created,id",
    { event: event.id }
  );
  var refunds = [];
  var pending = [];
  var day = dayLabel(iso(event.getString("starts_at")));
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var planned = refundsFor(txApp, entry, false);
    refunds = refunds.concat(planned.refunds);
    entry.set("status", "cancelled");
    txApp.save(entry);
    giveBackFreeEntry(txApp, entry, ctx.now);
    if (entry.getString("customer")) {
      var n = notifyLib.notify(txApp, {
        customer: entry.getString("customer"),
        type: "booking_cancelled",
        title: name + " is cancelled",
        body:
          name +
          " on " +
          day +
          " is cancelled." +
          (entry.getInt("paid") > 0 ? " Anything you paid is refunded at the till." : " Sorry for the change."),
        link: "/account/bookings",
        email: true,
      });
      pending = pending.concat(n.pending || []);
    }
  }
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: "event_cancel",
    collection: "booking_events",
    record: event.id,
    meta: { entries: entries.length, refunds: refunds },
    ip: ctx.ip,
  });
  return { ok: true, event: event, cancelled: entries.length, refunds: refunds, pending: pending };
}

// ---------------------------------------------------------------------
// Events through the collection API
// ---------------------------------------------------------------------

/**
 * The checks on an event written through the collection API (managers and
 * admins create and publish there): it ends after it starts, it is
 * cancelled through its route (so its entries are), and once published it
 * does not land on a table that is booked or taken by another event.
 * Returns a refusal ({ status, message }) or null.
 */
function eventWriteProblem(app, record, isNew) {
  var b = shared();
  var start = iso(record.getString("starts_at"));
  var end = iso(record.getString("ends_at"));
  if (!start || !end || Date.parse(end) <= Date.parse(start)) {
    return { status: 400, message: "The event has to end after it starts." };
  }
  var status = record.getString("status");
  var before = isNew ? "" : record.original().getString("status");
  if (status === "cancelled" && before !== "cancelled") {
    return { status: 400, message: "Cancel an event from Bookings, so its entries are cancelled and told." };
  }
  if (status !== "published") return null;
  var resourceIds = idsOf(record, "resources");
  if (!resourceIds.length) return null;
  var shapes = [];
  var records = byIds(app, "resources", resourceIds);
  for (var i = 0; i < resourceIds.length; i++) {
    if (records[resourceIds[i]]) shapes.push(resourceShape(records[resourceIds[i]]));
  }
  var window = { starts_at: start, ends_at: end };
  var busy = busyByResource(app, shapes, new Date(start), new Date(end), new Date(), {
    excludeEvent: isNew ? "" : record.id,
  });
  for (var j = 0; j < shapes.length; j++) {
    var clash = b.clashProblem(shapes[j], window, busy[shapes[j].id] || []);
    if (clash) return { status: 409, message: clash };
  }
  return null;
}

/** Whether an event's update moves its times, so its entries have to follow. */
function eventTimesChanged(record) {
  var original = record.original();
  return (
    iso(original.getString("starts_at")) !== iso(record.getString("starts_at")) ||
    iso(original.getString("ends_at")) !== iso(record.getString("ends_at"))
  );
}

/** Move an event's live entries to its times, through the app it is given. */
function followEvent(app, event) {
  var entries = findAll(
    app,
    "bookings",
    "event = {:event} && kind = 'event' && (status = 'held' || status = 'confirmed')",
    "",
    { event: event.id }
  );
  for (var i = 0; i < entries.length; i++) {
    entries[i].set("starts_at", iso(event.getString("starts_at")));
    entries[i].set("ends_at", iso(event.getString("ends_at")));
    app.save(entries[i]);
  }
  return entries.length;
}

/** The collection API's own save, inside a transaction so an event and its entries move together. */
function nextInTransaction(e) {
  e.app.runInTransaction(function (txApp) {
    var outer = e.app;
    e.app = txApp;
    try {
      e.next();
    } finally {
      e.app = outer;
    }
  });
}

/** The names of the fields a request changed, for an audit row (never their values). */
function changedFields(record) {
  var original = record.original();
  var data = record.fieldsData();
  var out = [];
  for (var key in data) {
    if (key === "updated" || key === "created") continue;
    var a = data[key];
    var b2 = original.get(key);
    if (JSON.stringify(a) !== JSON.stringify(b2)) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------
// Paying at the till (sales.pb.js and lib/salerefund.js)
// ---------------------------------------------------------------------

/**
 * A `booking` line on `POST /api/vault/sales/complete`, before the sale's
 * transaction: the booking, still live and not waiting for a place, and the
 * amount (`unit_price`, else what is left to pay), never more than is left
 * once the ticket's other lines for the same booking are counted. One unit;
 * on the Booking till product when the line names one or the shop has one
 * switched on, else on none (it reports under Other). Returns { ok, plan }
 * in the sale route's own plan shape, or a refusal.
 *
 * ctx: { vatRegistered, planned (the lines planned so far) }.
 */
function saleLine(app, raw, index, ctx) {
  var util = require(__hooks + "/lib/vaultutil.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var vat = require(__hooks + "/lib/shared/vat.js");
  var n = index + 1;
  if (util.asStr(raw.item)) return refusal(400, "Line " + n + " names a stock item and a booking. Send one or the other.");
  var booking = findById(app, "bookings", util.asStr(raw.booking));
  if (!booking) return refusal(404, "Line " + n + " is a booking that was not found. Reload the bookings.");
  var name = label(app, booking);
  var status = booking.getString("status");
  if (status === "cancelled") return refusal(409, name + " is cancelled. Take it off the ticket.");
  if (status === "no_show") return refusal(409, name + " was a no-show. Take it off the ticket.");
  if (booking.getString("kind") === "event" && status === "held") {
    var event = findById(app, "booking_events", booking.getString("event"));
    if (event && waitlistFor(app, event).indexOf(booking.id) >= 0) {
      return refusal(409, name + " is on the waitlist. Take payment when a place frees.");
    }
  }
  if (util.asInt(raw.qty, 1) > 1) return refusal(400, "A booking goes on the ticket once. Key the amount instead.");

  var product = null;
  var productId = util.asStr(raw.product);
  if (productId) {
    product = findById(app, "till_products", productId);
    if (!product || product.getString("kind") !== "booking") {
      return refusal(400, "Line " + n + " puts a booking on a key that is not for bookings. Take it off and add the booking again.");
    }
  } else {
    try {
      product = app.findFirstRecordByFilter("till_products", "kind = 'booking' && active = true");
    } catch (err) {
      product = null;
    }
  }

  var onTicket = 0;
  var planned = ctx.planned || [];
  for (var i = 0; i < planned.length; i++) {
    if (planned[i].booking && planned[i].booking.id === booking.id) onTicket += planned[i].unitPrice;
  }
  var left = Math.max(0, booking.getInt("price") - booking.getInt("paid") - onTicket);
  if (left <= 0) return refusal(409, name + " is paid in full. Take it off the ticket.");
  var given = raw.unit_price !== undefined && raw.unit_price !== null && raw.unit_price !== "";
  var amount = given ? util.asInt(raw.unit_price, 0) : left;
  if (amount < 1) return refusal(400, "Key an amount for " + name + ".");
  if (amount > left) return refusal(409, name + " has " + money.formatGBP(left) + " left to pay. Change the amount.");

  var taxScheme = product ? product.getString("tax_scheme") || "standard" : "standard";
  var rate = product ? product.getFloat("vat_rate") : vat.STANDARD_VAT_RATE;
  var sentTitle = util.asStr(raw.title);
  return {
    ok: true,
    plan: {
      index: index,
      product: product,
      item: null,
      booking: booking,
      kind: "booking",
      game: null,
      sku: "",
      title: (sentTitle || name).slice(0, 300),
      label: name,
      qty: 1,
      unitPrice: amount,
      overrideFrom: null,
      taxScheme: taxScheme,
      vatRate: vat.rateFor({ taxScheme: taxScheme, rate: product ? rate : vat.STANDARD_VAT_RATE, vatRegistered: ctx.vatRegistered }),
    },
  };
}

/**
 * Inside the sale's transaction: each booking on the ticket re-read, still
 * live and with room left for what this sale pays (so two tills cannot pay
 * one booking twice over its price), `paid` moved by the lines' amounts, a
 * held booking confirmed, and a `booking_paid` audit row each.
 * ctx: { sale, number, staffId, ip }.
 */
function settle(txApp, planned, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var totals = {};
  var order = [];
  for (var i = 0; i < planned.length; i++) {
    if (!planned[i].booking) continue;
    var id = planned[i].booking.id;
    if (totals[id] === undefined) {
      totals[id] = 0;
      order.push(id);
    }
    totals[id] += planned[i].unitPrice;
  }
  for (var j = 0; j < order.length; j++) {
    var live = findById(txApp, "bookings", order[j]);
    if (!live) return refusal(409, "A booking on this ticket was removed while the sale was open. Reload the bookings.");
    var name = label(txApp, live);
    var status = live.getString("status");
    if (status === "cancelled" || status === "no_show") {
      return refusal(409, name + " was cancelled while this sale was open. Take it off the ticket.");
    }
    var before = live.getInt("paid");
    var left = live.getInt("price") - before;
    if (totals[order[j]] > left) {
      return refusal(
        409,
        left > 0
          ? name + " has " + money.formatGBP(left) + " left to pay. Change the amount."
          : name + " is paid in full. Take it off the ticket."
      );
    }
    live.set("paid", before + totals[order[j]]);
    if (status === "held") live.set("status", "confirmed");
    txApp.save(live);
    auditLib.writeAuditLog(txApp, {
      actor: ctx.staffId,
      action: "booking_paid",
      collection: "bookings",
      record: live.id,
      meta: {
        sale: ctx.sale.id,
        number: ctx.number,
        amount: totals[order[j]],
        paid: before + totals[order[j]],
        price: live.getInt("price"),
        from: status,
        to: live.getString("status"),
      },
      ip: ctx.ip,
    });
  }
  return { ok: true };
}

/**
 * Inside a refund's transaction: a refunded booking line takes what it
 * settled (its unit price for each unit refunded) back off the booking's
 * `paid`, never below 0, with a `booking_unpaid` audit row. The booking's
 * status is left as it is. ctx: { ref, staffId, ip }.
 */
function unpay(txApp, line, qty, ctx) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var live = findById(txApp, "bookings", line.getString("booking"));
  if (!live) return;
  var amount = line.getInt("unit_price") * qty;
  var before = live.getInt("paid");
  var after = Math.max(0, before - amount);
  live.set("paid", after);
  txApp.save(live);
  auditLib.writeAuditLog(txApp, {
    actor: ctx.staffId,
    action: "booking_unpaid",
    collection: "bookings",
    record: live.id,
    meta: { sale_line: line.id, ref: ctx.ref, amount: before - after, paid: after },
    ip: ctx.ip,
  });
}

// ---------------------------------------------------------------------
// The crons (bookings_crons.pb.js)
// ---------------------------------------------------------------------

/**
 * The day-before reminders: every held or confirmed booking starting
 * tomorrow, shop time, not on a waitlist and not reminded before (its
 * `booking_reminder` audit row), gets a notification (push where subscribed)
 * and an email through lib/notify.js when it has a customer, or an email to
 * the address on the booking when it has none. One transaction a booking;
 * mail goes after it commits. Returns { sent }.
 */
function remind(app, now) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var notifyLib = require(__hooks + "/lib/notify.js");
  var money = require(__hooks + "/lib/shared/money.js");
  var b = shared();
  var tomorrow = b.addDays(b.shopDateOf(now), 1);
  var bounds = b.shopDayBounds(tomorrow);
  var due = findAll(
    app,
    "bookings",
    "(status = 'held' || status = 'confirmed') && starts_at >= {:from} && starts_at < {:to}",
    "starts_at",
    { from: pbDate(bounds.starts_at), to: pbDate(bounds.ends_at) }
  );
  var waiting = {};
  var eventsSeen = {};
  var sent = 0;
  for (var i = 0; i < due.length; i++) {
    var booking = due[i];
    var eventId = booking.getString("event");
    if (eventId && !eventsSeen[eventId]) {
      eventsSeen[eventId] = true;
      var ev = findById(app, "booking_events", eventId);
      if (ev) {
        var list = waitlistFor(app, ev);
        for (var w = 0; w < list.length; w++) waiting[list[w]] = true;
      }
    }
    if (waiting[booking.id]) continue;
    var done = null;
    try {
      done = app.findFirstRecordByFilter("audit_log", "action = 'booking_reminder' && record = {:id}", { id: booking.id });
    } catch (err) {
      done = null;
    }
    if (done) continue;
    var customerId = booking.getString("customer");
    var email = booking.getString("email");
    if (!customerId && !email) continue;

    var start = iso(booking.getString("starts_at"));
    var end = iso(booking.getString("ends_at"));
    var owed = Math.max(0, booking.getInt("price") - booking.getInt("paid"));
    var payLine = owed > 0 ? " " + money.formatGBP(owed) + " is left to pay at the till." : "";
    var title;
    var body;
    if (booking.getString("kind") === "event") {
      var event = findById(app, "booking_events", eventId);
      var eventName = event ? event.getString("name") : "Your event";
      title = eventName + " is tomorrow";
      body = "You are entered in " + eventName + " tomorrow, " + dayLabel(start) + ", from " + b.shopClock(start) + "." + payLine;
    } else {
      var res = findById(app, "resources", booking.getString("resource"));
      title = "Your booking tomorrow";
      body =
        (res ? res.getString("name") : "Your booking") +
        " is booked for you tomorrow, " +
        dayLabel(start) +
        ", from " +
        b.shopClock(start) +
        " to " +
        b.shopClock(end) +
        "." +
        payLine;
    }

    var pending = [];
    try {
      app.runInTransaction(function (txApp) {
        if (customerId) {
          var n = notifyLib.notify(txApp, {
            customer: customerId,
            type: "booking_reminder",
            title: title,
            body: body,
            link: "/account/bookings",
            email: true,
          });
          pending = n.pending || [];
        } else {
          pending = [{ to: email, subject: title, text: body }];
        }
        auditLib.writeAuditLog(txApp, {
          actor: "system",
          action: "booking_reminder",
          collection: "bookings",
          record: booking.id,
          meta: { starts_at: start, customer: customerId, emailed: pending.length > 0 },
        });
      });
    } catch (err) {
      console.log("[cron:bookings_remind] " + booking.id + " failed: " + err);
      continue;
    }
    notifyLib.sendPending(app, pending);
    sent += 1;
  }
  return { sent: sent };
}

/**
 * Weekly events made ahead: for every event that repeats weekly and is not
 * itself a repeat, each weekly occurrence in the next four weeks (the shared
 * `repeatWindows`, the same shop clock time every week) that has no row yet
 * is made as its own published event pointing back at the first. The first
 * week being finished or called off does not stop the series; unticking
 * `repeat_weekly` does, and a draft has not started one. A repeat that would
 * land on a booked table is made as a draft and the shop told, so nobody's
 * booking is taken from under them. A repeat once made is never made again,
 * even if it was cancelled. Returns { made, drafts }.
 */
function repeatEvents(app, now) {
  var auditLib = require(__hooks + "/lib/audit.js");
  var notifyLib = require(__hooks + "/lib/notify.js");
  var b = shared();
  var roots = findAll(app, "booking_events", "repeat_weekly = true && status != 'draft' && repeat_of = ''", "starts_at");
  var made = 0;
  var drafts = 0;
  for (var i = 0; i < roots.length; i++) {
    var root = roots[i];
    var first = { starts_at: iso(root.getString("starts_at")), ends_at: iso(root.getString("ends_at")) };
    var windows = b.repeatWindows(first, now, 28);
    for (var w = 0; w < windows.length; w++) {
      var window = windows[w];
      var pending = [];
      var wasDraft = false;
      var didMake = false;
      try {
        app.runInTransaction(function (txApp) {
          var existing = findAll(txApp, "booking_events", "repeat_of = {:root} && starts_at = {:start}", "", {
            root: root.id,
            start: pbDate(window.starts_at),
          });
          if (existing.length) return;
          var resourceIds = idsOf(root, "resources");
          var clashText = "";
          if (resourceIds.length) {
            var shapeMap = byIds(txApp, "resources", resourceIds);
            var shapes = [];
            for (var r = 0; r < resourceIds.length; r++) {
              if (shapeMap[resourceIds[r]]) shapes.push(resourceShape(shapeMap[resourceIds[r]]));
            }
            var busy = busyByResource(txApp, shapes, new Date(window.starts_at), new Date(window.ends_at), now, {});
            for (var s = 0; s < shapes.length && !clashText; s++) {
              clashText = b.clashProblem(shapes[s], window, busy[shapes[s].id] || []) || "";
            }
          }
          var copy = new Record(txApp.findCollectionByNameOrId("booking_events"), {
            name: root.getString("name"),
            game: root.getString("game"),
            format: root.getString("format"),
            starts_at: window.starts_at,
            ends_at: window.ends_at,
            capacity: root.getInt("capacity"),
            entry_fee: root.getInt("entry_fee"),
            member_fee: root.getInt("member_fee"),
            online: root.getBool("online"),
            status: clashText ? "draft" : "published",
            repeat_weekly: false,
            repeat_of: root.id,
            resources: resourceIds,
            description: root.getString("description"),
          });
          txApp.save(copy);
          auditLib.writeAuditLog(txApp, {
            actor: "system",
            action: "event_repeat",
            collection: "booking_events",
            record: copy.id,
            meta: { repeat_of: root.id, starts_at: window.starts_at, status: copy.getString("status") },
          });
          if (clashText) {
            var n = notifyLib.notify(txApp, {
              staffAll: true,
              type: "event_repeat_clash",
              title: root.getString("name") + " on " + dayLabel(window.starts_at) + " is a draft",
              body: clashText.split(". ")[0] + ". Move the booking or the event, then publish the event.",
              link: "/counter/bookings",
            });
            pending = n.pending || [];
            wasDraft = true;
          }
          didMake = true;
        });
      } catch (err) {
        console.log("[cron:booking_events_repeat] " + root.id + " failed: " + err);
        continue;
      }
      notifyLib.sendPending(app, pending);
      if (didMake) made += 1;
      if (wasDraft) drafts += 1;
    }
  }
  return { made: made, drafts: drafts };
}

module.exports = {
  LIVE: LIVE,
  iso: iso,
  pbDate: pbDate,
  instant: instant,
  dateParam: dateParam,
  dayLabel: dayLabel,
  findById: findById,
  shopHours: shopHours,
  resourceShape: resourceShape,
  isMember: isMember,
  busyFor: busyFor,
  placeProblem: placeProblem,
  availability: availability,
  eventEntries: eventEntries,
  waitlistFor: waitlistFor,
  placesFor: placesFor,
  views: views,
  view: view,
  payments: payments,
  eventViews: eventViews,
  label: label,
  statusRefusal: statusRefusal,
  prepareCreate: prepareCreate,
  writeCreate: writeCreate,
  prepareMove: prepareMove,
  writeMove: writeMove,
  refundsFor: refundsFor,
  prepareCancel: prepareCancel,
  writeCancel: writeCancel,
  noShowProblem: noShowProblem,
  checkInProblem: checkInProblem,
  setStatus: setStatus,
  checkOut: checkOut,
  prepareWalkIn: prepareWalkIn,
  writeWalkIn: writeWalkIn,
  stations: stations,
  customerFromScan: customerFromScan,
  entryOf: entryOf,
  cancelEvent: cancelEvent,
  eventWriteProblem: eventWriteProblem,
  eventTimesChanged: eventTimesChanged,
  followEvent: followEvent,
  nextInTransaction: nextInTransaction,
  changedFields: changedFields,
  saleLine: saleLine,
  settle: settle,
  unpay: unpay,
  remind: remind,
  repeatEvents: repeatEvents,
};
