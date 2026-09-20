/// <reference path="../pb_data/types.d.ts" />

/**
 * idphotos.pb.js - the ID check and the one way back to the photo.
 *
 *   POST /api/vault/customers/{id}/id-check   (multipart)
 *   GET  /api/vault/id-photo/{id}             (admin + step-up)
 *
 * docs/PLAN.md, "Security, GDPR and record keeping": the photo is
 * encrypted in this route with $security.encrypt and a key from the
 * environment (never from pb_data) before it is saved, and the only way to
 * see it again is the view route, which needs an admin role plus a step-up
 * confirmation from the last ten minutes, writes its audit row before it
 * decrypts anything, and serves the bytes with Cache-Control: no-store.
 *
 * GG_ID_PHOTO_KEY must be a 32-character key ($security.encrypt is
 * AES-256-GCM and rejects anything else). Without it the upload route
 * refuses with 500 rather than storing a photo in the clear.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/customers/{id}/id-check
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/customers/{id}/id-check",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const base64 = require(`${__hooks}/lib/base64.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    /** A form field, from the parsed body or straight off the multipart form. */
    function field(body, name) {
      const fromBody = util.asStr(body[name]);
      if (fromBody) return fromBody;
      try {
        return util.asStr(e.request.formValue(name));
      } catch (err) {
        return "";
      }
    }

    /** The MIME type of an uploaded image, from its extension. */
    function mimeFor(name) {
      const lower = String(name || "").toLowerCase();
      if (/\.png$/.test(lower)) return "image/png";
      if (/\.webp$/.test(lower)) return "image/webp";
      if (/\.heic$/.test(lower)) return "image/heic";
      return "image/jpeg";
    }

    const staff = e.auth;
    const customerId = e.request.pathValue("id");
    const body = util.body(e);
    const now = new Date();
    const nowIso = now.toISOString();

    const key = $os.getenv("GG_ID_PHOTO_KEY");
    if (!key) {
      throw e.internalServerError(
        "ID photo key is not configured. Ask Richard to set GG_ID_PHOTO_KEY on the server.",
        null
      );
    }

    let customer = null;
    try {
      customer = e.app.findRecordById("customers", customerId);
    } catch (err) {
      throw e.notFoundError("Customer not found. Search again or add them.", null);
    }

    let priv = null;
    try {
      priv = e.app.findFirstRecordByFilter("customer_private", "customer = {:customer}", {
        customer: customerId,
      });
    } catch (err) {
      priv = null;
    }

    const idType = field(body, "id_type");
    const idExpiry = field(body, "id_expiry");
    const idRefLast4 = field(body, "id_ref_last4");
    const dob = field(body, "dob");
    const address = field(body, "address");

    if (!idType) {
      throw e.badRequestError("Pick the type of ID you checked.", null);
    }
    if (!idExpiry) {
      throw e.badRequestError("Enter the expiry date shown on the ID.", null);
    }
    if (util.isPast(idExpiry, now)) {
      throw e.error(422, "That ID has expired. Ask for one that is still in date.", null);
    }

    const uploads = e.findUploadedFiles("photo");
    if (!uploads || uploads.length === 0 || !uploads[0]) {
      throw e.badRequestError("Take a photo of the ID before saving the check.", null);
    }
    const upload = uploads[0];

    // Read the bytes, base64 them, then encrypt that text: $security.encrypt
    // takes and returns text, so the photo goes in as a base64 string and
    // the .enc file on disk holds the ciphertext, never the image.
    let plainBytes = null;
    let reader = null;
    try {
      reader = upload.reader.open();
      plainBytes = toBytes(reader);
    } catch (err) {
      throw e.badRequestError("That photo could not be read. Take it again.", null);
    } finally {
      if (reader) {
        try {
          reader.close();
        } catch (err) {
          // Nothing useful to do if the reader will not close.
        }
      }
    }

    let cipherText = "";
    try {
      cipherText = $security.encrypt(base64.encode(plainBytes), key);
    } catch (err) {
      throw e.internalServerError(
        "ID photo key is not valid. It must be exactly 32 characters.",
        null
      );
    }

    const mime = field(body, "mime") || mimeFor(upload.name || upload.originalName);

    const settings = util.settings(e.app);
    const retentionMonths = settings ? settings.getInt("id_photo_retention_months") || 12 : 12;
    const expiresAt = util.addMonths(now, retentionMonths).toISOString();

    let result = null;
    let halt = null;
    try {
      e.app.runInTransaction((txApp) => {
        const doc = new Record(txApp.findCollectionByNameOrId("id_documents"), {
          customer: customerId,
          taken_by: staff.id,
          taken_at: nowIso,
          expires_at: expiresAt,
          mime: mime,
        });
        doc.set(
          "photo",
          $filesystem.fileFromBytes(cipherText, `id-${$security.randomString(12)}.enc`)
        );
        txApp.save(doc);

        if (priv) {
          const livePriv = txApp.findRecordById("customer_private", priv.id);
          livePriv.set("id_status", "verified");
          livePriv.set("id_type", idType);
          livePriv.set("id_expiry", idExpiry);
          if (idRefLast4) livePriv.set("id_ref_last4", idRefLast4);
          if (dob) livePriv.set("dob", dob);
          if (address) livePriv.set("address", address);
          livePriv.set("id_verified_by", staff.id);
          livePriv.set("id_verified_at", nowIso);
          txApp.save(livePriv);
        }

        // Identifiers only: never the ID number, the address or the photo
        // path (pb/README.md, and audit.pb.js's note on the same rule).
        auditLib.writeAuditLog(txApp, {
          actor: staff.id,
          action: "id_check",
          collection: "id_documents",
          record: doc.id,
          meta: { customer: customerId, expires_at: expiresAt },
          ip: e.realIP(),
        });

        result = {
          id_document: doc.id,
          id_status: "verified",
          id_expiry: idExpiry,
          expires_at: expiresAt,
        };
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
// GET /api/vault/id-photo/{id}  (admin + step-up)
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/id-photo/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const stepup = require(`${__hooks}/lib/stepup.js`);
    const base64 = require(`${__hooks}/lib/base64.js`);
    const auditLib = require(`${__hooks}/lib/audit.js`);

    const staff = util.requireAdmin(e);
    stepup.requireStepUp(e);

    const key = $os.getenv("GG_ID_PHOTO_KEY");
    if (!key) {
      throw e.internalServerError(
        "ID photo key is not configured. Ask Richard to set GG_ID_PHOTO_KEY on the server.",
        null
      );
    }

    const docId = e.request.pathValue("id");
    let doc = null;
    try {
      doc = e.app.findRecordById("id_documents", docId);
    } catch (err) {
      throw e.notFoundError("That ID photo has been deleted on its retention schedule.", null);
    }

    const fileName = doc.getString("photo");
    if (!fileName) {
      throw e.notFoundError("That ID photo has been deleted on its retention schedule.", null);
    }

    // The audit row goes in before anything is decrypted, so a view that
    // then fails for any reason is still on the record as an attempt.
    auditLib.writeAuditLog(e.app, {
      actor: staff.id,
      action: "id_photo_view",
      collection: "id_documents",
      record: doc.id,
      meta: { customer: doc.getString("customer") },
      ip: e.realIP(),
    });

    let cipherText = "";
    const fsys = e.app.newFilesystem();
    try {
      const reader = fsys.getReader(doc.baseFilesPath() + "/" + fileName);
      cipherText = toString(reader);
    } catch (err) {
      throw e.notFoundError("That ID photo has been deleted on its retention schedule.", null);
    } finally {
      try {
        fsys.close();
      } catch (err) {
        // Nothing useful to do if the filesystem will not close.
      }
    }

    let bytes = null;
    try {
      bytes = base64.decode(toString($security.decrypt(cipherText, key)));
    } catch (err) {
      throw e.internalServerError(
        "That ID photo could not be decrypted. Check GG_ID_PHOTO_KEY has not changed.",
        null
      );
    }

    const header = e.response.header();
    header.set("Cache-Control", "no-store");
    header.set("Content-Disposition", "inline");
    header.set("X-Content-Type-Options", "nosniff");

    return e.blob(200, doc.getString("mime") || "image/jpeg", bytes);
  },
  $apis.requireAuth("staff")
);
