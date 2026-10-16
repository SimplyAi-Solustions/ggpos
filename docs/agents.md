# Agents in GG Vault

GG Vault gives an AI agent the same access an admin has, through its own token, so Gandalf (the shop's agent on the Mac Mini, Claude Code run through Buzz) can look things up, price cards, research UK sold comps, run reports and manage bookings for the shop. This file is the how-to: creating an agent, connecting Claude Code or Hermes to GG Vault, what every tool does, and waking an agent when a member of staff asks for research.

The contract is `docs/api-contract-launch.md`, section 5. The server side is `pb/pb_hooks/agents.pb.js`, `mcp.pb.js` and `research.pb.js` with their `lib/` modules; the bridge is `services/mcp/stdio.mjs`.

## What an agent is

- A member of staff of kind **agent** with the **admin** role: the shop chose full admin access.
- It has no password anybody knows and no PIN. It reaches GG Vault with a **token that lasts a year**, shown once when it is made.
- Everything it does is in the audit log under its own name. Settings, Agents lists its last 50 actions.
- It never appears on the lock screen, cannot unlock a till, cannot approve a manager override, cannot sign in with a password, and cannot pass a step-up. Anything that needs a person's password in the last ten minutes (ID photos, refunds, staff changes, registering a till) stays with a person.

## Creating an agent

1. Sign in as an admin and open **Settings**, then **Agents**.
2. **Add an agent**: a name (for example Gandalf) and a note saying where it runs. You confirm your password once.
3. The token is shown **once**, with a Copy button and the Hermes `config.yaml` block ready to paste. Copy it now: GG Vault keeps no copy it can show again.

**New token** issues a fresh one and stops the old one at that moment (use it if a token may have leaked, or once a year). **Switch off** stops the agent at once; switching it back on does not bring the old token back, so give it a new one.

## Connecting Claude Code (Gandalf)

Add GG Vault once, for every project on the Mac Mini, with the token from Settings, Agents:

```bash
claude mcp add --transport http --scope user ggvault \
  https://ggpos.ggentertainment.co.uk/api/vault/mcp \
  --header "Authorization: Bearer <the agent's token>"
```

Start a new Claude Code session and run `/mcp`: `ggvault` should show as connected, and its tools arrive as `mcp__ggvault__stock_search` and so on. To check it worked, ask "what is in the GG Vault research list?"; it should call `mcp__ggvault__research_list`. Claude Code has no webhook receiver of its own, so rather than being woken it checks the research list on a schedule (every few minutes in opening hours); see "Research and waking an agent" below.

## Connecting Hermes

Hermes reads MCP servers from `~/.hermes/config.yaml` under `mcp_servers`, and names each tool `mcp_<server>_<tool>`, so GG Vault's tools arrive as `mcp_ggvault_stock_search` and so on. Use one of the two ways below, not both.

### Straight to GG Vault over HTTPS (preferred)

```yaml
mcp_servers:
  ggvault:
    url: "https://ggpos.ggentertainment.co.uk/api/vault/mcp"
    headers:
      Authorization: "Bearer <the agent's token>"
    timeout: 120
```

The endpoint speaks MCP's JSON-RPC over HTTP and answers every POST with JSON. It keeps no session and offers no event stream (a GET is 405), which every current client handles.

### Through the stdio bridge

For a client that only runs local MCP servers. The bridge has no dependencies and needs Node 20 or newer; copy `services/mcp/stdio.mjs` to the agent's machine or use it from a checkout of this repository.

```yaml
mcp_servers:
  ggvault:
    command: "node"
    args: ["/path/to/ggpos/services/mcp/stdio.mjs"]
    env:
      GGVAULT_URL: "https://ggpos.ggentertainment.co.uk"
      GGVAULT_TOKEN: "<the agent's token>"
```

It reads one JSON-RPC message per line on stdin, posts each to `/api/vault/mcp` with the token, and writes each answer on its own line. A refused token comes back as an error saying to give the agent a new one.

Restart Hermes (or its gateway) after changing `config.yaml`. To check it worked, ask Gandalf "what is in the GG Vault research list?"; it should call `mcp_ggvault_research_list`.

### Checking the endpoint by hand

```bash
curl -s https://ggpos.ggentertainment.co.uk/api/vault/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## The tools

Every tool calls GG Vault's own routes with the agent's token, so the same rules, refusals and audit rows apply as for a member of staff at the counter. A refusal comes back as a tool error in GG Vault's own words (for example "That is not an ebay.co.uk item link. Paste the listing's own URL (ebay.co.uk/itm/...)."). Money is integer pence, and every amount comes with a `_gbp` twin in pounds (`"price": 5999, "price_gbp": "£59.99"`). No images are sent.

| Tool | What it does |
| --- | --- |
| `stock_search` | Search stock by title, SKU, set code, number or barcode; filter by status, kind, branch or whether it shows online. |
| `stock_get` | One item by id or SKU, with its card or retro title, cost, price, branch, location and notes. |
| `stock_update` | Change an item's price (pence), its branch, or whether it shows on the website. |
| `category_tree` | Every branch of the category tree as a path and an id. |
| `card_search` | Find a card by name or by set and number ("sv151 199"). |
| `card_prices` | Every price source for a card in a finish, the chosen one marked, the condition applied; `refresh` asks the live sources again. |
| `retro_search` | Find a retro title GG Vault knows; `lookup` also asks IGDB. |
| `retro_prices` | Every price source for a retro title at loose, boxed or CIB. |
| `uk_comp_add` | Record a UK eBay sale from the last 30 days with its listing link. It leads every other source for 30 days. |
| `research_list` | Research requests (open by default), each with its search words and the eBay sold link to start from. |
| `research_create` | Open a request yourself. |
| `research_claim` | Say you are on a request. |
| `research_complete` | Finish a request with a short result and up to 20 comps; each becomes a UK sold comp on the card or retro title. |
| `research_cancel` | Cancel a request that is not needed. |
| `customer_search`, `customer_get` | Find customers; one customer with Guild membership, tier, store credit, points and ID status. |
| `guild_join` | Join a customer to the GG Guild, or make a new member. |
| `dashboard` | Sales, cost, profit, margin, buy-ins, stock value, by day and category, top items, payment mix. |
| `report` | Any report by key and date range (sales, buyins, margin, stock, channels, customers, loyalty, cash, compliance, vat). |
| `till_x` | The X report running now. Nothing printed or saved. |
| `bookings_availability`, `bookings_list` | Free slots on a day; bookings between two dates. |
| `booking_create`, `booking_move`, `booking_cancel` | Book a slot or an event entry, move one, cancel one. |
| `events_list`, `event_create` | Tournaments and events. |
| `tradeins_list`, `tradein_get` | Buy-ins and their lines. |
| `quotes_list`, `quote_get`, `quote_offer` | Remote quotes; putting an offer on one notifies the customer. |
| `vault_api` | Any other GG Vault route, as the agent. |

## Research and waking an agent

Staff press **Ask an agent** beside the price sources on a trade-in line, in price check or on an item page. GG Vault makes a research request with the card's name, set and number and, when a webhook is set, calls it straight away so the agent can start rather than wait to be asked.

**The agent's job**: `research_claim`, open the request's `ebay_url` (ebay.co.uk sold and completed listings from UK sellers), pick the closest sales from the last 30 days, then `research_complete` with a sentence and the comps: each one's price in pence, the date it sold and its own `ebay.co.uk/itm/...` link. For a card, use near-mint sale prices where you can tell; the offer applies the line's own condition. The comps land as UK sold comps, so the trade-in line's price picks them up at once and staff see them in the Research list.

### The webhook

Set it in Settings, Agents: the address to call and a secret of 16 characters or more (Make a secret fills one in). GG Vault never shows the secret again, only that one is set.

On every new request GG Vault posts JSON to the address with a 3 second timeout. A request is never held up or refused because the agent did not answer.

```json
{
  "event_type": "research.requested",
  "sent_at": "2026-10-16T10:02:11.000Z",
  "data": {
    "id": "kpd778bfezfetas",
    "query": "Charizard ex 151 199 holo",
    "title": "Charizard ex · 151 · 199",
    "card": "sm9tmjrpupdl6dx",
    "condition": "LP",
    "finish": "holo",
    "status": "open",
    "ebay_url": "https://www.ebay.co.uk/sch/i.html?_nkw=Charizard+ex+151+199+holo&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1",
    "requested_by": { "id": "x1tdv4a555qoz0x", "name": "Sam", "kind": "person" }
  }
}
```

With a secret set, it is signed four ways at once, so any receiver can check it:

| Header | Value |
| --- | --- |
| `X-GG-Signature` | HMAC-SHA256 of the raw body with the secret, lowercase hex. |
| `X-Webhook-Signature` | The same value, for Hermes's webhook adapter. |
| `X-Webhook-Timestamp` | Unix seconds when it was sent. |
| `X-Webhook-Signature-V2` | HMAC-SHA256 of `<timestamp>.<body>`, hex: Hermes's replay-protected check. |

To verify by hand: `hmac_sha256(secret, raw_body).hexdigest() == X-GG-Signature`, comparing in constant time.

### Waking Gandalf with Hermes's webhook gateway

Hermes's gateway can take webhooks and turn them into a prompt for the agent. Add a route in `~/.hermes/config.yaml`, using the same secret as in GG Vault:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        ggvault-research:
          events: ["research.requested"]
          secret: "<the webhook secret from Settings, Agents>"
          prompt: >-
            GG Vault research request {data.id}: find UK sold prices for "{data.query}".
            Claim it with research_claim, search {data.ebay_url}, then complete it with
            research_complete and the comps you found.
          deliver: "log"
```

Then set GG Vault's webhook address to that route, for example `http://<mac-mini>:8644/webhooks/ggvault-research`, reachable from the server (a Tailscale address works well). The gateway answers at once and runs the agent in the background, which keeps inside GG Vault's 3 second timeout.

## Security notes

- A token is shown once and is never stored, logged or shown again by GG Vault. If one leaks, press New token.
- The webhook secret is never answered by any route, never in `GET /api/vault/config`, and never in the audit log.
- MCP tool calls are audited as `mcp_call` with the tool's name and whether it worked, never its arguments, which can carry a customer's name.
- An agent cannot make another agent or re-key one: both need an admin's own password.
