/**
 * Registers and their cash sessions (docs/api-contract-epos.md, sections 1
 * and 3).
 *
 * A register is a till and its drawer. Every route that takes `register`
 * and is called without one uses the default register: the active one with
 * the lowest `sort`. Since the EPOS schema (1789820860) a cash session
 * belongs to a register, and at most one is open per register.
 *
 * require() this from inside each handler, not at file top level - see
 * pb/README.md on pb_hooks isolation.
 */

/** The default register's record, or null when there is none. */
function defaultRegister(app) {
  try {
    var rows = app.findRecordsByFilter("registers", "active = true", "sort,created", 1, 0);
    return rows.length ? rows[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * The register a request names, or the default one when it names none.
 * Returns { register } or { status, message } for the route to refuse with:
 * 404 for an unknown id, 409 for a register that is switched off, 409 when
 * the shop has no active register at all.
 */
function resolve(app, id) {
  var wanted = id ? String(id) : "";
  if (!wanted) {
    var fallback = defaultRegister(app);
    if (!fallback) {
      return {
        status: 409,
        message: "There is no till set up. Add one under Settings, Tills.",
      };
    }
    return { register: fallback };
  }
  var row = null;
  try {
    row = app.findRecordById("registers", wanted);
  } catch (err) {
    row = null;
  }
  if (!row) return { status: 404, message: "That register was not found." };
  if (!row.getBool("active")) {
    return {
      status: 409,
      message: "That register is switched off. Switch it on under Settings first.",
    };
  }
  return { register: row };
}

/**
 * The open cash session on a register, or null. A session written before
 * the EPOS schema, or by a caller that named no register, has an empty
 * `register`; it counts as the default register's.
 */
function openSession(app, registerId) {
  var id = registerId ? String(registerId) : "";
  var fallback = defaultRegister(app);
  if (!id && fallback) id = fallback.id;
  try {
    return app.findFirstRecordByFilter("cash_sessions", "closed_at = '' && register = {:r}", { r: id });
  } catch (err) {
    // Fall through to the unassigned session check.
  }
  if (fallback && id === fallback.id) {
    try {
      return app.findFirstRecordByFilter("cash_sessions", "closed_at = '' && register = ''");
    } catch (err) {
      return null;
    }
  }
  return null;
}

module.exports = {
  defaultRegister: defaultRegister,
  resolve: resolve,
  openSession: openSession,
};
