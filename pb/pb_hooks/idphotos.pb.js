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
 * The bytes go into $security.encrypt as an Array<number> and come back out
 * of $security.decrypt through toBytes(), so a photo is never turned into a
 * base64 string in either direction. A 320 KB photo encrypts in about 20 ms
 * this way; the base64 round trip it replaced took about 15 seconds for
 * 200 KB (see lib/base64.js).
 *
 * The stored MIME type is sniffed from the first bytes of the upload, never
 * taken from a client-supplied form field or a file extension, so a page of
 * HTML named photo.jpg cannot be stored and later served back as an image.
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
    const auditLib = require(`${__hooks}/lib/audit.js`);

    // The client already downscales, so anything larger than this is a
    // mistake rather than a photo of a passport.
    const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

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

    /** Four bytes at `at` as lower-case ASCII, or "" when they run past the end. */
    function tag(bytes, at) {
      if (bytes.length < at + 4) return "";
      let out = "";
      for (let i = at; i < at + 4; i++) out += String.fromCharCode(bytes[i] & 0xff);
      return out.toLowerCase();
    }

    /**
     * The real MIME type of an upload, from its first bytes. Returns "" for
     * anything that is not one of the photo formats a phone or the counter
     * tablet produces.
     */
    function sniffMime(bytes) {
      if (bytes.length < 12) return "";
      const b = bytes;
      if ((b[0] & 0xff) === 0xff && (b[1] & 0xff) === 0xd8 && (b[2] & 0xff) === 0xff) {
        return "image/jpeg";
      }
      if (
        (b[0] & 0xff) === 0x89 &&
        (b[1] & 0xff) === 0x50 &&
        (b[2] & 0xff) === 0x4e &&
        (b[3] & 0xff) === 0x47
      ) {
        return "image/png";
      }
      if (tag(b, 0) === "riff" && tag(b, 8) === "webp") return "image/webp";
      if (tag(b, 4) === "ftyp") {
        const brand = tag(b, 8);
        if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic";
        if (brand === "mif1" || brand === "msf1") return "image/heif";
      }
      return "";
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
    if (idRefLast4 && idRefLast4.length > 4) {
      throw e.badRequestError("Enter only the last four characters of the ID number.", null);
    }

    const uploads = e.findUploadedFiles("photo");
    if (!uploads || uploads.length === 0 || !uploads[0]) {
      throw e.badRequestError("Take a photo of the ID before saving the check.", null);
    }
    const upload = uploads[0];
    if (upload.size > MAX_PHOTO_BYTES) {
      throw e.badRequestError(
        "That photo is over 8 MB. Take it again at a lower resolution.",
        null
      );
    }

    // Read at most the cap plus one byte, so an upload that lies about its
    // size is still refused rather than pulled into memory whole.
    let plainBytes = null;
    let reader = null;
    try {
      reader = upload.reader.open();
      plainBytes = toBytes(reader, MAX_PHOTO_BYTES + 1);
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
    if (plainBytes.length > MAX_PHOTO_BYTES) {
      throw e.badRequestError(
        "That photo is over 8 MB. Take it again at a lower resolution.",
        null
      );
    }

    // Sniffed, never taken from the request: a client-supplied `mime` field
    // and the file's own extension are both ignored.
    const mime = sniffMime(plainBytes);
    if (!mime) {
      throw e.badRequestError(
        "That file is not a photo. Take a JPEG or PNG photo of the ID.",
        null
      );
    }

    // $security.encrypt takes the byte array as it is, so the .enc file on
    // disk holds the ciphertext and the image never becomes a string.
    let cipherText = "";
    try {
      cipherText = $security.encrypt(plainBytes, key);
    } catch (err) {
      throw e.internalServerError(
        "ID photo key is not valid. It must be exactly 32 characters.",
        null
      );
    }

    const settings = util.settings(e.app);
    const retentionMonths = settings ? settings.getInt("id_photo_retention_months") || 12 : 12;
    const expiresAt = util.addMonths(now, retentionMonths).toISOString();

    // Nothing in here can refuse for a business reason (every check above
    // has already run), so there is no `halt` to carry back out the way the
    // trade-in and sale routes do.
    let result = null;
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

    // Straight back to bytes: no base64 anywhere on this path.
    let bytes = null;
    try {
      bytes = toBytes($security.decrypt(cipherText, key));
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
