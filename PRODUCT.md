# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

GG Vault has three audiences, all connected to GG Entertainment's shop in Bolsover, Chesterfield.

- **Staff at the counter.** They work at a shared counter PC (wired scanner, label printer) and on their own phones, often mid-transaction with a customer stood in front of them. Most counter work happens one-handed on a phone: buy-ins, quick stock lookups, printing a label.
- **Customers, on their phones.** They sign in to "My Vault" to see their trade-in history, store credit, loyalty points and QR card, or to submit a quote from photos before they visit. Nobody uses My Vault on a desktop; assume a phone screen and sometimes a weak signal.
- **The owner, as admin.** Sets pricing rules, the loyalty programme, staff accounts and shop settings from the same app, without needing a developer.

## Jobs to Be Done

- When a customer brings items to sell, staff need to check what they are worth, capture ID if paying cash, and pay a fair price without holding up the queue.
- When stock comes in, staff need to identify it, price it, label it and put it away quickly.
- When a customer buys something, staff need to ring it up, apply any loyalty perk or reward, and update stock in one action.
- When the shop is quiet, staff need to know what to reprice, what to chase up on eBay, and what has not moved in months.
- When a customer wants to know if it is worth the drive in, they need an indicative price from their phone before they leave the house.
- When a customer wants to track what they are owed, they need to see their credit, points and trade-in history without asking staff.
- The owner needs to change a pricing rule, add a loyalty reward, or see the week's numbers, without asking a developer to ship anything.

## Product Purpose

GG Vault is the shop's system of record for every individual item: what came in, from whom, what it is worth, what it sold for, and where it went. SumUp takes the payment; GG Vault is the truth for stock, trade-ins, customers and loyalty. It exists because listing thousands of individual card singles in SumUp is impractical, and because a card shop's real bottleneck is buying in stock fairly and quickly, not only selling it.

Success looks like: stock counts that match the shelves, buy-ins priced consistently against live market data, no cash paid out without ID on file, and a loyalty programme the owner can reshape as the shop's offer changes.

## Positioning

General point-of-sale systems sell things; they do not know what a graded Charizard is worth today, do not capture ID for a cash buy-in, and do not run a loyalty programme an owner can edit without a developer. GG Vault is built around the item, not the transaction: every card, cartridge and box has a provenance (who sold it, what it is worth, where it is, what it sold for), priced first against UK sources and only then against converted US and EU prices, with a loyalty engine and customer portal built on the same record.

## Operating Context

- A busy shop counter, often with a queue, where staff move between the till, the shelves and the customer.
- Most staff interaction is one-handed on a phone, not a keyboard and mouse.
- One shared counter PC drives a USB keyboard-wedge barcode scanner and an ORGSTA T003 label printer.
- An optional customer-facing tablet sits on the counter, mirroring baskets and buy-in offers back to the customer.
- Connectivity is sometimes poor, in the shop unit, the back room, or a customer's home doing a remote quote; the app has to keep working, or fail obviously, when the network does not.
- Retro stock is often photographed on a plain background at the counter rather than looked up from a catalogue.

## Capabilities and Constraints

- GBP only. Every amount stored and shown is an integer of pence, formatted as £. No other currency is ever shown as a standalone figure.
- UK pricing first. Foreign prices (Cardmarket EUR, TCGplayer USD, PriceCharting USD) are always converted to GBP before anything sees them, and shown only as supporting detail next to the converted figure.
- No cash payout without ID on file. There is no cash-without-ID path for a trade-in, and cash above the shop's configured cap is refused outright.
- GDPR applies throughout: ID photos, seller records and loyalty data all carry retention limits and an erasure path (see `docs/retention-schedule.md`, `docs/privacy-notice.md` and `docs/dpia.md`).
- Runs on a single PocketBase instance on one VPS. No horizontal scaling, no multiple regions; the shop is one location.
- One shop, one till float, one label printer model (ORGSTA T003) at launch.
- Staff devices are a mix of a shared Windows counter PC and personal phones; the app has to work on both without assuming a specific device.

## Brand Commitments

The names in use: **GG Vault** (the system as a whole), **The Counter** (staff side), **My Vault** (customer side), **GG Guild** (the loyalty programme, keeping the marketing site's name). Any of these can be renamed.

### Voice

The voice carries over from the marketing site, ggentertainment.co.uk: plain-spoken, dry, honest, no hype. The site's own copy sets the tone: "Bring the loft box in. Fair prices, no haggling theatre." The app's copy follows the same register: short, specific, no exclamation marks, no "Oops" or "Awesome". Full copy rules live in `CLAUDE.md`.

## Evidence on Hand

- Three reference screens supplied by the owner, committed at `docs/design-references/`: `nova-add-item.png`, `atlas-scan-item.png`, `atlas-details.png`. These define the visual target for every screen; `DESIGN.md` records the system built from them.
- The marketing site's design tokens, pulled from ggentertainment.co.uk on 19 September 2026 (colours, fonts, shadows, radius; recorded in `docs/PLAN.md`).
- `docs/PLAN.md`, the approved build plan, is the source of truth for scope, data model, screens and phasing.
- `packages/shared/src/sku.ts` is the shipped code format for every code the app prints or scans.

## Product Principles

- Every item has a provenance: what it is, who it came from, what it is worth, and where it went.
- UK pricing first, always shown in GBP; a foreign price is supporting evidence, never the headline figure.
- No cash paid for goods without ID on file first.
- SumUp takes the money; GG Vault's own record is the truth for stock.
- The loyalty programme is admin-editable. Rules, tiers and rewards change without a code change.

## Non-goals for v1

- Multiple shops or locations.
- A receipt printer (A4 or PDF receipts only at launch).
- Partial refunds (the data model allows it; the UI does not yet).
- Taking card payment directly through a SumUp Solo reader (planned for a later phase).
- Stripe-billed paid memberships (recorded manually by staff for now).
- Automated eBay UK sold-price comps (not available from eBay; staff enter UK sold comps manually).
- pokemontcg.io as a data source (deprecated, not used).
- Native mobile apps; the app is an installable PWA, not an App Store or Play Store build.
- Multi-currency display anywhere in the UI.

## Accessibility & Inclusion

WCAG AA contrast throughout, including the brand yellow, used carefully: white text on yellow never appears. Visible focus for keyboard users. Every control has a label. Tables are navigable by keyboard. Status is never colour-only. Touch targets are at least 48px on phones, and the primary workflows (scan, sell, buy-in) are usable one-handed.
