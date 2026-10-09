// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
/**
 * Agents, GG Vault's own MCP endpoint, and research requests
 * (docs/api-contract-launch.md, section 5; docs/EPOS-PLAN.md, decision 10).
 *
 * Pure and shared by the hooks (through the generated CommonJS copy in
 * pb/pb_hooks/lib/shared/agents.js) and the web, so the search words a
 * staff member's "Search eBay sold" opens are the words an agent is woken
 * with, and the Hermes config the Agents screen hands out matches the
 * endpoint the server serves.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESEARCH_STATUSES = exports.RESEARCH_EVENT = exports.MCP_SERVER_NAME = exports.MCP_PATH = exports.AGENT_TOKEN_DAYS = void 0;
exports.researchStatusWords = researchStatusWords;
exports.researchWords = researchWords;
exports.ebaySoldUrl = ebaySoldUrl;
exports.compRange = compRange;
exports.hermesConfig = hermesConfig;
/** How long an agent's token lasts: a year (the contract's "long-lived"). */
exports.AGENT_TOKEN_DAYS = 365;
/** The MCP endpoint, relative to the server's own address. */
exports.MCP_PATH = "/api/vault/mcp";
/**
 * The name GG Vault gives itself in an MCP client's config. Hermes names a
 * server's tools `mcp_<server>_<tool>`, so this keeps them short and readable
 * (`mcp_ggvault_stock_search`).
 */
exports.MCP_SERVER_NAME = "ggvault";
/** The event a new research request wakes an agent with. */
exports.RESEARCH_EVENT = "research.requested";
// ---------------------------------------------------------------------------
// Research requests
// ---------------------------------------------------------------------------
exports.RESEARCH_STATUSES = ["open", "claimed", "done", "cancelled"];
/** What the research list and the line's own block say about a request's state. */
function researchStatusWords(request) {
    var _a, _b;
    const who = (_b = (_a = request.claimed_by) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "An agent";
    if (request.status === "open")
        return "Waiting for an agent";
    if (request.status === "claimed")
        return `${who} is looking`;
    if (request.status === "cancelled")
        return "Cancelled";
    const count = request.comps.length;
    if (count === 0)
        return `${who} found nothing sold`;
    return `${who} found ${count} sold`;
}
/** Finish words a seller actually puts in a title. A normal printing says nothing. */
const FINISH_WORDS = {
    holo: "holo",
    reverse: "reverse holo",
    reverse_holo: "reverse holo",
    reverseholo: "reverse holo",
    foil: "foil",
    first_edition: "1st edition",
    firstedition: "1st edition",
    "1st_edition": "1st edition",
};
/** Completeness words a UK retro listing uses. Loose is the default, so it says nothing. */
const COMPLETENESS_WORDS = {
    boxed: "boxed",
    cib: "complete",
};
function clean(text) {
    return String(text !== null && text !== void 0 ? text : "")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * The search words for a card, a retro title or a free title: its name, set
 * and number, and the condition word only where a seller would write it (a
 * graded card's grade, a holo or reverse finish, a boxed or complete game).
 * A near-mint or played raw card says nothing, because almost no sold
 * listing does.
 */
function researchWords(subject) {
    const parts = [];
    const name = clean(subject.name);
    if (name)
        parts.push(name);
    const setName = clean(subject.setName);
    if (setName && !name.toLowerCase().includes(setName.toLowerCase()))
        parts.push(setName);
    const number = clean(subject.number);
    if (number && !name.includes(number))
        parts.push(number);
    const finish = clean(subject.finish).toLowerCase();
    if (subject.kind === "retro") {
        const words = COMPLETENESS_WORDS[finish];
        if (words)
            parts.push(words);
    }
    else if (finish) {
        const words = FINISH_WORDS[finish.replace(/[\s-]/g, "_")];
        if (words && !name.toLowerCase().includes(words))
            parts.push(words);
    }
    const grade = clean(subject.grade);
    if (subject.kind === "graded" && grade)
        parts.push(grade);
    return parts.join(" ").slice(0, 300);
}
/**
 * ebay.co.uk's sold and completed listings for some search words: sold
 * (`LH_Sold=1`), finished (`LH_Complete=1`), and from UK sellers only
 * (`LH_PrefLoc=1`), because a UK sold comp is a UK sale.
 */
function ebaySoldUrl(words) {
    const query = encodeURIComponent(clean(words)).replace(/%20/g, "+");
    return `https://www.ebay.co.uk/sch/i.html?_nkw=${query}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1`;
}
/** The lowest and highest comp, in pence, or null with none. */
function compRange(comps) {
    const prices = comps.map((comp) => comp.price).filter((price) => Number.isInteger(price) && price > 0);
    if (!prices.length)
        return null;
    return { low: Math.min(...prices), high: Math.max(...prices) };
}
function yamlString(value) {
    return JSON.stringify(value);
}
/**
 * The `mcp_servers` block for Hermes's `config.yaml`, both ways: straight
 * to the MCP endpoint over HTTP with the token as the bearer, or through
 * the stdio bridge for a client that only runs local servers. Paste one.
 */
function hermesConfig(input) {
    const base = input.baseUrl.replace(/\/+$/, "");
    const bridge = input.bridgePath || "/path/to/ggpos/services/mcp/stdio.mjs";
    const http = [
        "mcp_servers:",
        `  ${exports.MCP_SERVER_NAME}:`,
        `    url: ${yamlString(base + exports.MCP_PATH)}`,
        "    headers:",
        `      Authorization: ${yamlString(`Bearer ${input.token}`)}`,
        "    timeout: 120",
    ].join("\n");
    const stdio = [
        "mcp_servers:",
        `  ${exports.MCP_SERVER_NAME}:`,
        '    command: "node"',
        `    args: [${yamlString(bridge)}]`,
        "    env:",
        `      GGVAULT_URL: ${yamlString(base)}`,
        `      GGVAULT_TOKEN: ${yamlString(input.token)}`,
    ].join("\n");
    return { http, stdio };
}
