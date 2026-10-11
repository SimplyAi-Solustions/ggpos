/// <reference path="../pb_data/types.d.ts" />

/**
 * How browsers may keep the app PocketBase serves from pb_public.
 *
 * - Every page, sw.js, registerSW.js and the manifest go out with
 *   `Cache-Control: no-cache`: a browser may keep them but must ask whether
 *   there is a newer build before using them again, so an update reaches it
 *   on its next load. Without a header a browser guesses how long to keep a
 *   page, and a kept page from the build before asks for script files the
 *   update has removed.
 * - `/assets/` file names carry a hash of their contents, so a name never
 *   changes meaning: one that is there is kept for a year. One that is not
 *   there is a plain 404. PocketBase would otherwise answer it with the app's
 *   own page, which a browser refuses as a script ("'text/html' is not a
 *   valid JavaScript MIME type"), and a 404 is the honest answer that lets
 *   the app's reload (apps/web/src/lib/stale-build.ts) take over.
 * - `/tutorials/` holds the tutorial videos and their posters
 *   (apps/web/public/tutorials, mounted read-only on the server by
 *   deploy/docker-compose.yml). A missing one is a 404 for the same reason,
 *   since a video player handed the app's page just says it cannot play.
 *   The app asks for each with `?v=` from the file's own contents, so that
 *   address is kept for a year; a bare address is checked each time.
 * - `/api/` (which sets its own caching where it wants any) and the `/_/`
 *   dashboard are left alone.
 *
 * pb_public sits beside pb_hooks in the Docker image, in dev.sh and in
 * check.sh. When it is not there (no index.html beside the hooks), nothing
 * is refused: the 404 only ever answers for a file that is really missing.
 */
routerUse(
  new Middleware(
    (e) => {
      const method = e.request.method;
      if (method !== "GET" && method !== "HEAD") return e.next();
      const path = String(e.request.url.path);
      if (path === "/api" || path.indexOf("/api/") === 0) return e.next();
      if (path === "/_" || path.indexOf("/_/") === 0) return e.next();

      const assets = path.indexOf("/assets/") === 0;
      const tutorials = path.indexOf("/tutorials/") === 0;
      if (assets || tutorials) {
        const publicDir = `${__hooks}/../pb_public`;
        let served = false;
        try {
          served = !$os.stat(`${publicDir}/index.html`).isDir();
        } catch (err) {
          served = false;
        }
        if (!served) return e.next();
        let present = false;
        if (path.indexOf("..") < 0) {
          try {
            present = !$os.stat(`${publicDir}${path}`).isDir();
          } catch (err) {
            present = false;
          }
        }
        if (!present) return e.string(404, "Not found");
        const versioned = assets || String(e.request.url.query().get("v") || "") !== "";
        e.response
          .header()
          .set("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "no-cache");
        return e.next();
      }

      e.response.header().set("Cache-Control", "no-cache");
      return e.next();
    },
    -1000,
    "ggAppShellCache"
  )
);
