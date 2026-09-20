/// <reference path="../pb_data/types.d.ts" />

/**
 * stepup.pb.js - POST /api/vault/step-up
 *
 * Re-checks the signed-in staff member's password and hands back a token
 * good for ten minutes, which the routes marked **step-up** in
 * docs/api-contract.md then require in an X-Step-Up header. See
 * lib/stepup.js for the token itself and the key it is signed with.
 *
 * Everything the handler needs is require()d inside the handler body -
 * see pb/README.md on hook isolation.
 */
routerAdd(
  "POST",
  "/api/vault/step-up",
  (e) => {
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const audit = require(`${__hooks}/lib/audit.js`);

    const staff = e.auth;
    const password = util.asStr(util.body(e).password);
    if (!password) {
      throw e.badRequestError("Enter your password to continue.", null);
    }

    if (!staff.validatePassword(password)) {
      // Deliberately the same wording whoever is asking: this is a
      // re-check of an account already signed in, so there is nothing to
      // enumerate, but there is also nothing useful to add.
      throw e.badRequestError("That password is not right. Try again.", null);
    }

    const issued = stepup.issue(staff);

    audit.writeAuditLog(e.app, {
      actor: staff.id,
      action: "step_up",
      collection: "staff",
      record: staff.id,
      meta: { expires_at: issued.expires_at },
      ip: e.realIP(),
    });

    return e.json(200, issued);
  },
  $apis.requireAuth("staff")
);
