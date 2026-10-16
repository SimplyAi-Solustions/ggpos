/// <reference path="../pb_data/types.d.ts" />

/**
 * mcp.pb.js - GG Vault's own MCP endpoint (docs/api-contract-launch.md,
 * section 5).
 *
 *   POST   /api/vault/mcp    (staff token as the bearer: an agent's, or a person's)
 *   GET    /api/vault/mcp    405: no server-sent stream is offered
 *   DELETE /api/vault/mcp    405: there are no sessions to end
 *
 * The Model Context Protocol's Streamable HTTP transport in its simplest
 * form: each POST carries one JSON-RPC message or a batch, and is answered
 * with `application/json` (202 and no body when it held only notifications
 * or responses). No `Mcp-Session-Id` is issued, so a client never opens a
 * GET stream. lib/mcp.js has the methods and the tools.
 *
 * Every tool runs against GG Vault's own routes with the caller's own
 * token, through `$http.send` back to this server's own address, so the
 * collection rules, the capabilities and every route's audit row apply
 * exactly as they do to the counter. The loopback address is
 * `GG_LOOPBACK_URL` when set; otherwise the address the request came in on
 * when that is this machine (127.0.0.1, localhost, ::1), else
 * http://127.0.0.1:8090, where the Docker image serves. A request's Host
 * header never sends the caller's token anywhere else.
 *
 * Each tool call is audited as `mcp_call` under the caller with the tool's
 * name and whether it worked; never its arguments, which can carry a
 * customer's name.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */
routerAdd(
  "POST",
  "/api/vault/mcp",
  (e) => {
    const mcp = require(`${__hooks}/lib/mcp.js`);
    const perms = require(`${__hooks}/lib/permissions.js`);
    const audit = require(`${__hooks}/lib/audit.js`);

    const MAX_BODY = 2 * 1024 * 1024;
    const caller = perms.caller(e);

    function loopbackBase() {
      const configured = String($os.getenv("GG_LOOPBACK_URL") || "").trim();
      if (configured) return configured.replace(/\/+$/, "");
      let host = "";
      try {
        host = String(e.request.host || "");
      } catch (err) {
        host = "";
      }
      if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(host)) return `http://${host}`;
      return "http://127.0.0.1:8090";
    }

    const base = loopbackBase();
    let authorization = "";
    try {
      authorization = e.request.header.get("Authorization") || "";
    } catch (err) {
      authorization = "";
    }
    const ip = e.realIP();

    function queryString(query) {
      const parts = [];
      const keys = Object.keys(query || {});
      for (let i = 0; i < keys.length; i++) {
        const value = query[keys[i]];
        if (value === undefined || value === null || value === "") continue;
        parts.push(`${encodeURIComponent(keys[i])}=${encodeURIComponent(String(value))}`);
      }
      return parts.length ? `?${parts.join("&")}` : "";
    }

    /** One call to GG Vault as the caller. Answers the JSON, or throws a tool error with GG Vault's sentence. */
    function send(method, path, query, body) {
      const config = {
        url: base + path + queryString(query),
        method: method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
          // The caller's own address, so a route's audit row and rate limit
          // read the agent rather than this server.
          "X-Forwarded-For": ip,
          "X-Real-IP": ip,
        },
        timeout: 60,
      };
      if (body !== undefined && method !== "GET") config.body = JSON.stringify(body);
      let res = null;
      try {
        res = $http.send(config);
      } catch (err) {
        const failed = new mcp.ToolError("GG Vault did not answer that call. Try again in a moment.");
        failed.status = 0;
        throw failed;
      }
      let text = "";
      try {
        text = toString(res.body);
      } catch (err) {
        text = "";
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (err) {
        json = null;
      }
      if (res.statusCode >= 400) {
        const said = json && typeof json.message === "string" && json.message ? json.message : `GG Vault answered ${res.statusCode}.`;
        const refused = new mcp.ToolError(said);
        refused.status = res.statusCode;
        throw refused;
      }
      return json === null ? { ok: true } : json;
    }

    const api = {
      send: send,
      get: (path, query) => send("GET", path, query),
      post: (path, body, query) => send("POST", path, query, body === undefined ? {} : body),
      patch: (path, body, query) => send("PATCH", path, query, body),
    };

    const ctx = {
      api: api,
      audit: (tool, ok, status, extra) => {
        const meta = { tool: tool, ok: ok };
        if (!ok && status) meta.status = status;
        if (extra && extra.method) meta.method = extra.method;
        if (extra && extra.path) meta.path = extra.path;
        try {
          audit.writeAuditLog(e.app, {
            actor: caller.id,
            action: "mcp_call",
            collection: "mcp",
            record: "",
            meta: meta,
            ip: ip,
          });
        } catch (err) {
          console.log(`[mcp] could not audit ${tool}: ${err}`);
        }
      },
    };

    let raw = "";
    try {
      raw = toString(e.request.body, MAX_BODY);
    } catch (err) {
      raw = "";
    }
    let message = null;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      return e.json(400, mcp.rpcError(null, -32700, "Parse error: the body is not JSON."));
    }

    if (Array.isArray(message)) {
      if (!message.length) return e.json(400, mcp.rpcError(null, -32600, "Invalid request: the batch is empty."));
      const answers = [];
      for (let i = 0; i < message.length; i++) {
        const answer = mcp.handle(message[i], ctx);
        if (answer) answers.push(answer);
      }
      if (!answers.length) return e.noContent(202);
      return e.json(200, answers);
    }

    const answer = mcp.handle(message, ctx);
    if (!answer) return e.noContent(202);
    return e.json(answer.error && answer.error.code === -32600 ? 400 : 200, answer);
  },
  $apis.requireAuth("staff")
);

routerAdd("GET", "/api/vault/mcp", (e) => {
  e.response.header().set("Allow", "POST");
  return e.json(405, { message: "GG Vault's MCP endpoint takes POST only. It offers no event stream." });
});

routerAdd("DELETE", "/api/vault/mcp", (e) => {
  e.response.header().set("Allow", "POST");
  return e.json(405, { message: "GG Vault's MCP endpoint keeps no sessions, so there is nothing to end." });
});
