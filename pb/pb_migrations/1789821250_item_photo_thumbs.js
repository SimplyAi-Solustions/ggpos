/// <reference path="../pb_data/types.d.ts" />

/**
 * Thumbnails for `items.photos` (docs/api-contract-launch.md, section 6).
 *
 * The public feed's `image.small` asks for `?thumb=640x0`, so the website's
 * grid of 24 cards loads small pictures rather than 24 photos at 1,600px.
 * PocketBase only makes the sizes a file field lists and answers any other
 * `?thumb=` with the original, so without this the feed still works, only
 * heavier. The same three widths the launch schema gives every other image
 * field. No data changes.
 *
 * `down()` takes the list away again.
 */
migrate(
  (app) => {
    const items = app.findCollectionByNameOrId("items");
    const photos = items.fields.getByName("photos");
    photos.thumbs = ["160x0", "320x0", "640x0"];
    app.save(items);
  },
  (app) => {
    const items = app.findCollectionByNameOrId("items");
    const photos = items.fields.getByName("photos");
    photos.thumbs = [];
    app.save(items);
  }
);
