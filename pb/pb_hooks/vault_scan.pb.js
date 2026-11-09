/// <reference path="../pb_data/types.d.ts" />

/**
 * vault_scan.pb.js - the vault app's Scan and Cards routes.
 *
 *   POST /api/vault/scan/identify     (staff)  { image, deep?, game? }
 *   GET  /api/vault/scan/cards        (staff)  ?q=&game=&limit=
 *   GET  /api/vault/scan/cards/{id}   (staff)
 *
 * identify reads a card photo with Claude Haiku 5.5 and reruns it on
 * Claude Sonnet 5.5 when Haiku cannot read the collector number or is
 * unsure, or when staff ask for a deep dive (`deep: true`). The read is
 * matched against our own `cards` catalogue, ranked, and returned with the
 * "every signal agrees" verdict. The decision and the bake-off behind it
 * are in ~/.buzz/RESEARCH/CARD_ID_BAKEOFF_RESULTS.md.
 *
 * The Anthropic key comes from the ANTHROPIC_API_KEY environment variable
 * (the PocketBase container reads deploy/.env), or settings.api_keys.anthropic.
 * It never leaves the server.
 *
 * The two GET routes only read the database: no adapter call, so search
 * stays fast while a customer waits. Nothing here writes, apart from
 * caching an illustrator name onto a card the first time it is opened.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// POST /api/vault/scan/identify
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/scan/identify",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const scan = require(`${__hooks}/lib/vault_scan.js`);
    const db = require(`${__hooks}/lib/vault_scan_db.js`);

    const body = util.body(e);
    let image = util.asStr(body.image);
    const deep = util.asBool(body.deep);
    const hint = util.asStr(body.game).toLowerCase();

    let mediaType = "image/jpeg";
    const prefix = image.match(/^data:(image\/(?:jpeg|png|webp));base64,/);
    if (prefix) {
      mediaType = prefix[1];
      image = image.slice(prefix[0].length);
    }
    if (!image || !/^[A-Za-z0-9+/=\s]+$/.test(image.slice(0, 200))) {
      throw e.badRequestError("Send the photo as a base64 JPEG.", null);
    }
    if (image.length > 7000000) {
      throw e.badRequestError("That photo is too large. Send it at 1,600 pixels or smaller.", null);
    }

    const settingsRow = util.settings(e.app);
    const apiKeys = settingsRow ? util.jsonField(settingsRow, "api_keys", {}) || {} : {};
    const key = String($os.getenv("ANTHROPIC_API_KEY") || apiKeys.anthropic || "").trim();
    if (!key) {
      throw e.error(503, "Photo ID is not set up on this server. Search for the card instead.", null);
    }

    function callModel(model) {
      const started = Date.now();
      let res = null;
      try {
        res = $http.send({
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          timeout: 45,
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 4000,
            output_config: { effort: "low" },
            messages: [
              {
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
                  { type: "text", text: scan.PROMPT },
                ],
              },
            ],
          }),
        });
      } catch (err) {
        console.log(`[vault_scan] ${model} call failed: ${err}`);
        return { ok: false, model: model };
      }
      if (res.statusCode !== 200) {
        console.log(`[vault_scan] ${model} answered ${res.statusCode}`);
        return { ok: false, model: model, status: res.statusCode };
      }
      const json = res.json || {};
      if (json.stop_reason === "refusal") return { ok: false, model: model };
      let text = "";
      const blocks = json.content || [];
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].type === "text") text += blocks[i].text || "";
      }
      const parsed = scan.parseModelJson(text);
      if (!parsed) return { ok: false, model: model };
      return { ok: true, model: model, read: scan.cleanRead(parsed), ms: Date.now() - started };
    }

    let result = callModel(deep ? scan.SONNET : scan.HAIKU);
    let escalated = false;
    if (!deep && (!result.ok || scan.needsDeepDive(result.read))) {
      const second = callModel(scan.SONNET);
      if (second.ok) {
        result = second;
        escalated = true;
      }
    }
    if (!result.ok) {
      throw e.error(502, "The card reader did not answer. Try again, or search for the card instead.", null);
    }

    const look = db.lookups(e.app);

    /** Our catalogue ranked against one read, asking the game's adapter (and writing through) when we hold nothing that matches. */
    function rankRead(read) {
      const gameKey = read.game || (["pokemon", "mtg", "onepiece", "lorcana"].indexOf(hint) >= 0 ? hint : "");
      let records = db.identifyPool(e.app, read, gameKey);
      let ranked = scan.rankForRead(read, records.map((record) => db.scoringShape(db.cardRow(e.app, record, look, false))));
      if ((!ranked.length || ranked[0].why.indexOf("number") < 0) && gameKey && (read.name_en || read.name_printed)) {
        try {
          const registry = require(`${__hooks}/adapters/registry.js`);
          const storage = require(`${__hooks}/adapters/storage.js`);
          const adapter = registry.adapterForGame(gameKey);
          const gameRecord = registry.gameRecord(e.app, gameKey);
          const found = adapter && gameRecord ? (adapter.search(read.name_en || read.name_printed) || []).slice() : [];
          // A name like "Mewtwo" has hundreds of prints: write the ones
          // carrying the read collector number through first.
          const wanted = read.collector_number ? scan.num(read.collector_number) : "";
          if (wanted) found.sort((a, b) => (scan.num(b && b.number) === wanted ? 1 : 0) - (scan.num(a && a.number) === wanted ? 1 : 0));
          const nowIso = new Date().toISOString();
          for (let i = 0; i < found.length && i < 40; i++) {
            if (!found[i] || !found[i].number) continue;
            try {
              const setRecord = storage.upsertCardSet(e.app, gameRecord.id, found[i].setCode, found[i].setName);
              if (setRecord) storage.upsertCard(e.app, gameRecord.id, setRecord, found[i], nowIso);
            } catch (err) {
              // One bad row never fails the scan.
            }
          }
          records = db.identifyPool(e.app, read, gameKey);
          ranked = scan.rankForRead(read, records.map((record) => db.scoringShape(db.cardRow(e.app, record, look, false))));
        } catch (err) {
          console.log(`[vault_scan] adapter fallback failed: ${err}`);
        }
      }
      return { records: records, ranked: ranked };
    }

    let matched = rankRead(result.read);
    // Haiku read something, but nothing we hold matches both its name and
    // its number (an attack name read as the card name, a misread digit):
    // Sonnet takes a second look before staff are asked to pick.
    const top = matched.ranked[0];
    if (!deep && !escalated && (!top || top.why.indexOf("name") < 0 || top.why.indexOf("number") < 0)) {
      const second = callModel(scan.SONNET);
      if (second.ok) {
        result = second;
        escalated = true;
        matched = rankRead(result.read);
      }
    }
    const read = result.read;
    const records = matched.records;
    const ranked = matched.ranked;

    const verdict = scan.agreement(read, ranked);
    const byId = {};
    for (let i = 0; i < records.length; i++) byId[records[i].id] = records[i];
    const candidates = ranked.slice(0, 6).map((entry) => {
      const row = db.cardRow(e.app, byId[entry.card.id], look, true);
      row.score = entry.score;
      row.why = entry.why;
      return row;
    });

    return e.json(200, {
      model: result.model,
      escalated: escalated,
      read: read,
      candidates: candidates,
      auto_accept: verdict.accept,
      reasons: verdict.reasons,
    });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/scan/cards?q=&game=&limit=
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/scan/cards",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const scan = require(`${__hooks}/lib/vault_scan.js`);
    const db = require(`${__hooks}/lib/vault_scan_db.js`);

    function queryParam(name) {
      try {
        const info = e.requestInfo();
        return util.asStr(info && info.query ? info.query[name] : "");
      } catch (err) {
        return "";
      }
    }

    const q = queryParam("q");
    const game = queryParam("game").toLowerCase();
    const limit = Math.max(1, Math.min(50, util.asInt(queryParam("limit"), 30)));
    if (q.length < 2) return e.json(200, { cards: [] });

    const parsed = scan.parseQuery(q);
    const look = db.lookups(e.app);
    const pool = db.searchPool(e.app, parsed, game);
    const scored = [];
    for (let i = 0; i < pool.length; i++) {
      const row = db.cardRow(e.app, pool[i], look, false);
      const score = scan.searchScore(parsed, row);
      if (score > 0) scored.push({ record: pool[i], row: row, score: score });
    }
    scored.sort((a, b) => b.score - a.score || String(b.row.release_date).localeCompare(String(a.row.release_date)));
    const cards = scored.slice(0, limit).map((entry) => db.cardRow(e.app, entry.record, look, true));
    return e.json(200, { cards: cards, parsed: parsed });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// GET /api/vault/scan/cards/{id}
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/scan/cards/{id}",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const db = require(`${__hooks}/lib/vault_scan_db.js`);

    let record = null;
    try {
      record = e.app.findRecordById("cards", e.request.pathValue("id"));
    } catch (err) {
      throw e.notFoundError("Card not found. Search for it again.", null);
    }
    const look = db.lookups(e.app);

    // The illustrator, fetched once from TCGdex for a Pokemon card and kept
    // on external_ids. Best effort: a slow TCGdex never holds the page up.
    const ext = util.jsonField(record, "external_ids", {}) || {};
    const gameRow = look.game(record.getString("game"));
    if (!ext.illustrator && ext.tcgdex && gameRow && gameRow.getString("key") === "pokemon") {
      try {
        const res = $http.send({ url: `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(ext.tcgdex)}`, method: "GET", timeout: 4 });
        if (res.statusCode === 200 && res.json && res.json.illustrator) {
          ext.illustrator = String(res.json.illustrator).slice(0, 120);
          record.set("external_ids", ext);
          e.app.save(record);
        }
      } catch (err) {
        // Leave it blank.
      }
    }

    const card = db.cardRow(e.app, record, look, false);
    const market = db.marketFor(e.app, record);
    card.nm_pence = market.chosen ? market.chosen.gbp_market : null;
    card.nm_source = market.chosen ? market.chosen.source : "";

    // UK sold comps: staff-entered and research-completed rows, with the
    // condition from the audit row that recorded them and the listing title
    // from the research request that found them.
    const sold = e.app.findRecordsByFilter(
      "price_snapshots",
      "card = {:card} && source = 'uk_sold_manual'",
      "-fetched_at",
      200,
      0,
      { card: record.id }
    );
    const conditionBySnapshot = {};
    try {
      const audits = e.app.findRecordsByFilter("audit_log", "collection = 'price_snapshots' && meta ~ {:card}", "-created", 500, 0, { card: record.id });
      for (let i = 0; i < audits.length; i++) {
        const meta = util.jsonField(audits[i], "meta", {}) || {};
        if (meta.condition) conditionBySnapshot[audits[i].getString("record")] = String(meta.condition).toUpperCase();
      }
    } catch (err) {
      // No audit rows readable: conditions default to NM below.
    }
    const titleByUrl = {};
    let research = null;
    try {
      const requests = e.app.findRecordsByFilter("research_requests", "card = {:card}", "-created", 30, 0, { card: record.id });
      for (let i = 0; i < requests.length; i++) {
        const status = requests[i].getString("status");
        if (!research && (status === "open" || status === "claimed")) {
          research = { id: requests[i].id, status: status, condition: requests[i].getString("condition") };
        }
        const comps = util.jsonField(requests[i], "comps", []) || [];
        for (let j = 0; j < comps.length; j++) {
          if (comps[j] && comps[j].url) titleByUrl[comps[j].url] = { title: comps[j].title || "", condition: comps[j].condition || "" };
        }
      }
    } catch (err) {
      research = null;
    }
    const comps = sold.map((row) => {
      const url = row.getString("evidence_url");
      const extra = titleByUrl[url] || {};
      return {
        id: row.id,
        pence: row.getInt("gbp_market"),
        sold_at: String(row.getString("fetched_at")).slice(0, 10),
        url: url,
        title: extra.title || "",
        condition: (conditionBySnapshot[row.id] || String(extra.condition || "").toUpperCase() || "NM").slice(0, 3),
        finish: row.getString("finish"),
      };
    });

    // Price history for the chart: every snapshot at the chosen finish,
    // oldest first. The chart draws the GBP figure only.
    const historyRows = e.app.findRecordsByFilter(
      "price_snapshots",
      "card = {:card} && finish = {:finish}",
      "fetched_at",
      600,
      0,
      { card: record.id, finish: market.finish || "" }
    );
    const history = historyRows.map((row) => ({
      at: String(row.getString("fetched_at")).slice(0, 10),
      pence: row.getInt("gbp_market"),
      source: row.getString("source"),
    }));

    // Other versions: the same name in the same game.
    let versions = [];
    try {
      const others = e.app.findRecordsByFilter(
        "cards",
        "game = {:game} && name = {:name} && id != {:id}",
        "-set.release_date",
        12,
        0,
        { game: record.getString("game"), name: record.getString("name"), id: record.id }
      );
      versions = others.map((other) => db.cardRow(e.app, other, look, true));
    } catch (err) {
      versions = [];
    }

    return e.json(200, {
      card: card,
      market: { finish: market.finish, chosen: market.chosen, sources: market.sources },
      comps: comps,
      history: history,
      versions: versions,
      research: research,
    });
  },
  $apis.requireAuth("staff")
);
