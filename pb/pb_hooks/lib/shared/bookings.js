// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * Bookings: tables, PC and console stations, rooms, and events
 * (docs/api-contract-launch.md, section 4; docs/EPOS-PLAN.md, decision 12).
 *
 * Pure and shared by the booking routes and the web (the day view, My Vault
 * and demo mode), so a slot the screen offers is a slot the server takes and
 * a price the till shows is the price the server charges. Times are stored
 * in UTC; opening hours are the shop's own clock, Europe/London, worked out
 * here by hand because the hooks' JavaScript has no time zone database.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_GRACE_MINUTES = exports.WEEKDAY_KEYS = exports.BOOKING_ACTIVE_STATUSES = exports.BOOKING_STATUSES = exports.RESOURCE_KINDS = void 0;
exports.isBritishSummerTime = isBritishSummerTime;
exports.shopTimeToUtc = shopTimeToUtc;
exports.shopDateOf = shopDateOf;
exports.weekdayOf = weekdayOf;
exports.hoursOn = hoursOn;
exports.overlaps = overlaps;
exports.daySlots = daySlots;
exports.bookingProblem = bookingProblem;
exports.shopClock = shopClock;
exports.slotPrice = slotPrice;
exports.bookingPrice = bookingPrice;
exports.sessionCharge = sessionCharge;
exports.entryFee = entryFee;
exports.placesLeft = placesLeft;
exports.RESOURCE_KINDS = ["table", "pc", "console", "room"];
exports.BOOKING_STATUSES = ["held", "confirmed", "checked_in", "completed", "cancelled", "no_show"];
/** A booking in one of these takes its time up. */
exports.BOOKING_ACTIVE_STATUSES = ["held", "confirmed", "checked_in"];
exports.WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** A part slot longer than this many minutes counts as a whole one at check-out. */
exports.SESSION_GRACE_MINUTES = 10;
// ---------------------------------------------------------------------------
// Shop time
// ---------------------------------------------------------------------------
/** The last Sunday of a month (0-based), as a UTC day of the month. */
function lastSunday(year, month) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
}
/**
 * Whether British Summer Time is in force at this instant: from 01:00 UTC on
 * the last Sunday of March to 01:00 UTC on the last Sunday of October.
 */
function isBritishSummerTime(at) {
    const year = at.getUTCFullYear();
    const start = Date.UTC(year, 2, lastSunday(year, 2), 1);
    const end = Date.UTC(year, 9, lastSunday(year, 9), 1);
    const t = at.getTime();
    return t >= start && t < end;
}
/** The UTC instant of a shop-time date ("2026-10-16") and clock time ("18:30"). */
function shopTimeToUtc(date, time) {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    const guess = new Date(Date.UTC(y !== null && y !== void 0 ? y : 0, (m !== null && m !== void 0 ? m : 1) - 1, d !== null && d !== void 0 ? d : 1, hh !== null && hh !== void 0 ? hh : 0, mm !== null && mm !== void 0 ? mm : 0));
    // Shop time is UTC+1 in summer: the instant is an hour earlier than the
    // same clock reading in UTC. Checked at the guess, which is right except
    // inside the changeover hour, when the shop is closed anyway.
    return isBritishSummerTime(guess) ? new Date(guess.getTime() - 3600000) : guess;
}
/** The shop-time date ("YYYY-MM-DD") an instant falls on. */
function shopDateOf(at) {
    const local = new Date(at.getTime() + (isBritishSummerTime(at) ? 3600000 : 0));
    return local.toISOString().slice(0, 10);
}
/** The weekday of a shop-time date. */
function weekdayOf(date) {
    var _a;
    const [y, m, d] = date.split("-").map(Number);
    return (_a = exports.WEEKDAY_KEYS[new Date(Date.UTC(y !== null && y !== void 0 ? y : 0, (m !== null && m !== void 0 ? m : 1) - 1, d !== null && d !== void 0 ? d : 1)).getUTCDay()]) !== null && _a !== void 0 ? _a : "sun";
}
/** The windows a resource is open on a date: its own hours, else the shop's. */
function hoursOn(resource, shopHours, date) {
    var _a;
    const hours = resource.hours && Object.keys(resource.hours).length > 0 ? resource.hours : shopHours;
    return (_a = hours[weekdayOf(date)]) !== null && _a !== void 0 ? _a : [];
}
// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------
/** Whether two time windows overlap (touching ends do not). */
function overlaps(a, b) {
    return Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at);
}
/**
 * Every slot of a resource on a shop-time date, within its opening windows,
 * `slot_minutes` apart, each marked free when nothing busy overlaps it and,
 * when `now` is given, it has not started yet.
 */
function daySlots(resource, shopHours, date, busy, now) {
    const step = Math.max(5, resource.slot_minutes || 60) * 60000;
    const out = [];
    for (const [open, close] of hoursOn(resource, shopHours, date)) {
        const end = shopTimeToUtc(date, close).getTime();
        for (let t = shopTimeToUtc(date, open).getTime(); t + step <= end; t += step) {
            const slot = { starts_at: new Date(t).toISOString(), ends_at: new Date(t + step).toISOString() };
            const taken = busy.some((window) => overlaps(slot, window));
            const past = now ? t < now.getTime() : false;
            out.push(Object.assign(Object.assign({}, slot), { free: !taken && !past }));
        }
    }
    return out;
}
/**
 * Why a booking of a resource from `starts_at` to `ends_at` cannot be made,
 * or null: inside its hours on that day, a whole number of slots, and clear
 * of everything busy.
 */
function bookingProblem(resource, shopHours, window, busy) {
    if (!resource.active)
        return `${resource.name} is switched off. Pick another.`;
    const start = Date.parse(window.starts_at);
    const end = Date.parse(window.ends_at);
    if (!(end > start))
        return "The booking has to end after it starts.";
    const step = Math.max(5, resource.slot_minutes || 60) * 60000;
    if ((end - start) % step !== 0)
        return `${resource.name} books in ${resource.slot_minutes}-minute slots.`;
    const date = shopDateOf(new Date(start));
    const inside = hoursOn(resource, shopHours, date).some(([open, close]) => {
        return start >= shopTimeToUtc(date, open).getTime() && end <= shopTimeToUtc(date, close).getTime();
    });
    if (!inside)
        return `${resource.name} is not open then. Pick a time within its hours.`;
    const clash = busy.find((other) => overlaps(window, other));
    if (clash) {
        return `${resource.name} is booked from ${shopClock(clash.starts_at)} to ${shopClock(clash.ends_at)}. Pick another time or another ${kindWord(resource)}.`;
    }
    return null;
}
function kindWord(resource) {
    const kind = resource.kind;
    return kind === "pc" ? "PC" : kind === "console" ? "console" : kind === "room" ? "room" : "table";
}
/** "18:00", shop time. */
function shopClock(iso) {
    const at = new Date(iso);
    const local = new Date(at.getTime() + (isBritishSummerTime(at) ? 3600000 : 0));
    return local.toISOString().slice(11, 16);
}
// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
/** The slot price for this customer: the member price for a Guild member when there is one. */
function slotPrice(resource, member) {
    return member && resource.member_price !== null && resource.member_price !== undefined
        ? resource.member_price
        : resource.price;
}
/** A booking's price and deposit for a window. */
function bookingPrice(resource, window, member) {
    var _a;
    const step = Math.max(5, resource.slot_minutes || 60) * 60000;
    const slots = Math.max(0, Math.round((Date.parse(window.ends_at) - Date.parse(window.starts_at)) / step));
    const price = slots * slotPrice(resource, member);
    return { slots, price, deposit: Math.min(price, (_a = resource.deposit) !== null && _a !== void 0 ? _a : 0) };
}
/**
 * A walk-in session's charge at check-out: whole slots from check-in, a part
 * slot counting as a whole one once it runs past the grace minutes, and
 * never less than one slot.
 */
function sessionCharge(resource, checkedInAt, checkedOutAt, member, graceMinutes = exports.SESSION_GRACE_MINUTES) {
    const minutes = Math.max(0, Math.floor((Date.parse(checkedOutAt) - Date.parse(checkedInAt)) / 60000));
    const step = Math.max(5, resource.slot_minutes || 60);
    const whole = Math.floor(minutes / step);
    const part = minutes - whole * step;
    const slots = Math.max(1, whole + (part > graceMinutes ? 1 : 0));
    return { minutes, slots, price: slots * slotPrice(resource, member) };
}
/** An event's entry fee for this customer. */
function entryFee(event, member) {
    return member && event.member_fee !== null && event.member_fee !== undefined ? event.member_fee : event.entry_fee;
}
/** Places left at an event, counting the party sizes of its live entries. */
function placesLeft(capacity, entries) {
    if (!(capacity > 0))
        return Number.POSITIVE_INFINITY;
    const taken = entries
        .filter((entry) => exports.BOOKING_ACTIVE_STATUSES.includes(entry.status) || entry.status === "completed")
        .reduce((sum, entry) => sum + Math.max(1, entry.party_size), 0);
    return Math.max(0, capacity - taken);
}
