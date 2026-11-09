/// <reference path="../pb_data/types.d.ts" />

/**
 * binders_wallet.pb.js - the My Vault wallet card (customer side only).
 *
 *   GET  /api/vault/wallet        the mirrored store credit balance
 *   POST /api/vault/wallet/token  a short-lived signed token for the QR code
 *
 * Epos Now is the till and the source of truth for store credit. The
 * balance here is read from credit_mirror, which a job on the shop Mac
 * writes; this file never computes or adjusts a balance. When the mirror is
 * missing or more than a day old the response says so and the wallet tells
 * the customer to ask at the counter.
 *
 * The staff scan side is not here: tokens are verified with the shared
 * secret in wallet_keys (lib/binders_wallet.js has the verify function).
 */

routerAdd(
  "GET",
  "/api/vault/wallet",
  (e) => {
    const W = require(`${__hooks}/lib/binders_wallet.js`);
    let row = null;
    try {
      row = e.app.findFirstRecordByFilter("credit_mirror", "customer = {:c}", { c: e.auth.id });
    } catch (err) {
      // No mirror row yet: the wallet shows no balance.
    }
    e.response.header().set("Cache-Control", "no-store");
    if (!row) return e.json(200, { balance_minor: null, balance_at: "", stale: true });
    const at = row.getString("balance_at");
    return e.json(200, {
      balance_minor: row.getInt("balance_minor"),
      balance_at: at,
      stale: W.balanceIsStale(at, Date.now(), 24),
    });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/wallet/token",
  (e) => {
    const W = require(`${__hooks}/lib/binders_wallet.js`);
    // The signing secret lives in wallet_keys so the staff scanner can use
    // the same one. Made once, on first demand, never sent to a client.
    let secret = "";
    try {
      secret = e.app
        .findFirstRecordByFilter("wallet_keys", "purpose = 'wallet_qr'", {})
        .getString("secret");
    } catch (err) {
      const col = e.app.findCollectionByNameOrId("wallet_keys");
      const rec = new Record(col);
      rec.set("purpose", "wallet_qr");
      rec.set("secret", $security.randomString(48));
      try {
        e.app.save(rec);
        secret = rec.getString("secret");
      } catch (raceErr) {
        // Two first-taps raced; the unique index kept one row. Read it.
        secret = e.app
          .findFirstRecordByFilter("wallet_keys", "purpose = 'wallet_qr'", {})
          .getString("secret");
      }
    }
    const token = W.signWalletToken(
      e.auth.id,
      Date.now() / 1000,
      secret,
      (data, key) => $security.hs256(data, key),
      $security.randomString(8)
    );
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, { token: token, ttl: W.TTL_SECONDS });
  },
  $apis.requireAuth("customers")
);
