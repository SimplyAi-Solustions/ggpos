/// <reference path="../pb_data/types.d.ts" />

/**
 * `staff.must_change_password`: the counter refuses to show anything but
 * the "Set a new password" screen while this is true.
 *
 * A bool, false for every staff row that already exists and for every one
 * created later, so nobody is locked out by this migration arriving. It is
 * readable wherever the rest of the staff record is - by an admin through
 * the collection API, and by the staff member themself in the record their
 * own sign-in hands back - and `pb_hooks/staff.pb.js` strips it from the
 * body of any update a non-admin makes, so a locked account cannot unlock
 * itself by writing the field.
 *
 * The first admin
 * ---------------
 * `1789819620_seed.js` creates the first admin from `GG_ADMIN_EMAIL` and
 * `GG_ADMIN_PASSWORD`, and it runs *before* this file (migrations apply in
 * filename order), so the field does not exist yet at the moment that row
 * is written. The flag is therefore set here rather than there, on the one
 * account that is still signing in with the password from the
 * environment: on a fresh database that is the row the seed has just made,
 * which is exactly what the brief asks for, and on a database that has
 * been running for a while it is an admin who never moved off the password
 * sitting in `.env`, who should be asked for a new one anyway. An admin who
 * has already changed their password, and every other staff row, is left
 * alone. Nothing here reads, logs or stores the password itself:
 * `validatePassword` is a hash comparison.
 *
 * `down()` drops the field, and with it every flag ever set on it.
 */
migrate(
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    staff.fields.add(new Field({ name: "must_change_password", type: "bool" }));
    app.save(staff);

    const adminEmail = $os.getenv("GG_ADMIN_EMAIL");
    const adminPassword = $os.getenv("GG_ADMIN_PASSWORD");
    if (!adminEmail || !adminPassword) return;

    let admin = null;
    try {
      admin = app.findFirstRecordByFilter("staff", "email = {:email}", { email: adminEmail });
    } catch (err) {
      // No such account: nothing to lock.
      return;
    }
    if (!admin || !admin.validatePassword(adminPassword)) return;

    admin.set("must_change_password", true);
    app.save(admin);
    console.log(
      `Seeded first admin (${adminEmail}) starts locked to a password change on first sign-in.`
    );
  },
  (app) => {
    const staff = app.findCollectionByNameOrId("staff");
    staff.fields.removeByName("must_change_password");
    app.save(staff);
  }
);
