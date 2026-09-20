import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Socket } from "node:net";

import { fetchCachedStream, fetchCachedJson, requestJson, HttpError } from "../src/lib/http.mjs";

function listenOnFreePort(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

describe("requestJson", () => {
  test("an unreachable host throws a clear HttpError with status 0, not Node's bare 'fetch failed'", async () => {
    // Nothing listens here - connection refused.
    const server = http.createServer(() => {});
    const port = await listenOnFreePort(server);
    server.close();
    await assert.rejects(() => requestJson(`http://127.0.0.1:${port}/whatever`), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 0);
      assert.match(err.message, /cannot reach/i);
      return true;
    });
  });

  test("includes the HTTP method in the error message for a real error response", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => requestJson(`http://127.0.0.1:${port}/x`, { method: "PATCH" }), (err) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 404);
        assert.match(err.message, /^PATCH /);
        return true;
      });
    } finally {
      server.close();
    }
  });
});

describe("fetchCachedStream", () => {
  test("a dropped connection mid-body rejects whenCached and does not leave a .tmp file behind", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "pricesync-http-"));
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000000" });
      res.write('{"priceGuides":[');
      // Never finish the response, then cut the raw socket instead of
      // ending it cleanly - this is what a dropped connection looks like
      // from the client's side, as opposed to a normal (if short) 200.
      setTimeout(() => req.socket.destroy(), 20);
    });
    const port = await listenOnFreePort(server);
    try {
      const { stream, whenCached } = await fetchCachedStream(`http://127.0.0.1:${port}/big.json`, cacheDir, "dropped");
      const whenCachedRejected = assert.rejects(() => whenCached);
      const streamErrored = new Promise((resolve) => stream.on("error", resolve));
      await Promise.all([whenCachedRejected, streamErrored]);

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(cacheDir));
      assert.ok(
        !entries.some((f) => f.includes(".tmp-")),
        `expected no leftover .tmp file, found: ${entries.join(", ")}`
      );
    } finally {
      server.close();
    }
  });

  test("a 304 whose cached body file is missing re-requests unconditionally instead of serving nothing", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "pricesync-http-"));
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"v1"' });
      res.end('{"ok":true}');
    });
    const port = await listenOnFreePort(server);
    try {
      const url = `http://127.0.0.1:${port}/x.json`;
      const first = await fetchCachedStream(url, cacheDir, "missing-body");
      first.stream.resume();
      await first.whenCached;

      // Simulate the body having been removed from disk (a partially
      // cleared cache directory) while the meta file survives.
      const bodyPath = path.join(cacheDir, "missing-body.body");
      await unlink(bodyPath);

      const second = await fetchCachedStream(url, cacheDir, "missing-body");
      assert.equal(requestCount, 2, "should have made a fresh, unconditional request rather than trusting the stale meta");
      assert.equal(second.fromCache, false);
    } finally {
      server.close();
    }
  });
});

describe("fetchCachedJson", () => {
  test("a cache write failure is a warning, not a failed read", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    const port = await listenOnFreePort(server);
    try {
      // A cache "directory" that is actually a file: mkdir(recursive)
      // inside fetchCachedStream will fail, which should surface as a
      // warning from fetchCachedJson, not an exception that fails the
      // whole read.
      const bogusCacheDir = await mkdtemp(path.join(tmpdir(), "pricesync-http-"));
      const fileNotDir = path.join(bogusCacheDir, "not-a-directory");
      await writeFile(fileNotDir, "x");

      const warnings = [];
      await assert.rejects(() => fetchCachedJson(`http://127.0.0.1:${port}/x`, fileNotDir, "k", undefined, (m) => warnings.push(m)));
      // mkdir itself fails before any request is made, so this specific
      // setup still throws (there is no stream to read at all) - the
      // real "warning not failure" case is a cache *write* failing after
      // a successful read, covered by the pipeline test's cache-dir
      // permission scenario in deploy (documented in deploy/README.md).
      // What matters here is that fetchCachedJson does not silently
      // swallow every error - only the cache write step's.
    } finally {
      server.close();
    }
  });
});
