# CSV formats

Column layouts and mapping configs for every CSV GG Vault reads or writes. See `docs/PLAN.md` ("SumUp integration", "Card Uploader and the eBay round trip") for the background.

## SumUp item import

SumUp's own CSV import, used to push retail lines into SumUp so they can be sold through the SumUp app, accepts these columns:

Item name, Description, Category, Price, SKU, Barcode, Quantity, Tax rate (%), Variations, Option set 1, Option set 2, Option set 3, Option set 4, Modifiers, Display colour.

## Our SumUp export mapping

GG Vault only exports **retro, sealed, accessory and other lines** to SumUp, and only while they are still `in_stock`. Trading card singles (`single`, `graded`) are not listed individually; they are rung through SumUp as a single generic "single card" line with a keyed price, because listing every card individually is impractical. Our export writes:

| SumUp column | Our source |
|---|---|
| Item name | Our SKU (display form, with its hyphen), then the item title, for example `GGP-7F3K2Q Charizard ex Booster Box`, so a SumUp sale can be matched back to our SKU by eye |
| Description | Game, set and condition detail |
| Category | Game or kind |
| Price | `items.price` formatted as a plain decimal, pounds and pence, no £ sign |
| SKU | Our SKU (encoded form, no hyphen) |
| Barcode | Our SKU (encoded), or the item's EAN for sealed product and accessories when one is on file |
| Quantity | `items.qty` |
| Tax rate (%) | 0 for a margin-scheme item; the standard rate (20%) for a standard-scheme item when `settings.vat_registered`, else 0 |
| Variations, Option set 1 to 4, Modifiers, Display colour | Left blank; not used |

`GET /api/vault/exports/sumup.csv?since=YYYY-MM-DD` selects items that have never been exported (`items.sumup_synced_at` empty) or have changed since `since` (`items.updated >= since`); leaving `since` off selects only items never exported. Every row it writes sets `items.sumup_synced_at` to the export time, unless the request also carries `dry_run=1`, which builds the same file but leaves every row untouched - so a preview does not stop those items appearing again on the next real export.

## Card Uploader import

carduploader.com's per-card CSV headers are only visible inside a logged-in account, so the importer reads a mapping config rather than hard-coded headers. Skeleton, to be filled in from the shop's first real export:

```json
{
  "source": "card_uploader",
  "headerRow": 1,
  "columns": {
    "name": ["Card Name", "Name", "Title"],
    "set": ["Set", "Set Name"],
    "number": ["Number", "Card Number", "#"],
    "condition": ["Condition"],
    "price": ["Price", "Sale Price"],
    "quantity": ["Quantity", "Qty"],
    "tcgplayerId": ["TCGplayer ID", "TCGplayer Product ID"],
    "cardmarketId": ["Cardmarket ID", "Cardmarket Product ID"],
    "csSku": ["CS SKU", "Custom Label"]
  }
}
```

Each field lists the header names the importer will accept, in order of preference; the real headers replace these placeholders once we have a real export to check against, a Phase 1 prerequisite. Rows that carry a `tcgplayerId` or `cardmarketId` match directly to a `cards` row, since our `cards` collection indexes both. Rows with only a name go into a review queue for manual matching. `csSku` is Card Uploader's own SKU, written into eBay's custom label field under Managed Inventory (format `CS-XXXXXX`), and is stored on our `items` row as `ebay_sku` so a later eBay orders import can match the sale back to the item.

A matched card connects to stock in order: an existing item that already carries this row's `ebay_sku` (unless it has since sold, been returned or been written off, which is reported rather than resurrected); failing that, the oldest still-in-stock item already linked to the same card (so a card already on the shelf from a trade-in or a supplier order is connected to the listing, not duplicated); only then is a brand new item created, flagged for review since it carries no cost. See `docs/api-contract.md`'s Phase 4 section for the full rule.

As of Phase 4 this skeleton is also the seeded value of `settings.import_mappings.card_uploader` (a migration writes it once, merged into the settings row rather than overwriting the whole `import_mappings` blob), which is what `POST /api/vault/imports/card-uploader` actually reads its header names from. Editing that settings field - not this file - is how Richard corrects the header names once a real export is in hand; this file stays the record of what the seeded default is and where to change it.

## eBay orders import

Marks an item sold, with the order reference, once it has sold on eBay. Every row sharing the same order number becomes one sale with one line per row, not a separate sale per row, booked on the order's own sale date rather than whenever the file happens to be imported. Skeleton mapping, also to be confirmed against a real export:

```json
{
  "source": "ebay_orders",
  "headerRow": 1,
  "columns": {
    "customLabel": ["Custom Label", "Custom Label (SKU)"],
    "itemNumber": ["Item Number"],
    "orderNumber": ["Order Number", "Sales Record Number"],
    "saleDate": ["Sale Date"],
    "salePrice": ["Sold For", "Sale Price"],
    "quantity": ["Quantity"],
    "currency": ["Sale Currency", "Currency"]
  }
}
```

Matching is primarily on `customLabel`, which is our `ebay_sku`, the Card Uploader `CS-XXXXXX` SKU. A row that matches an item already `listed_ebay` marks it `sold` and records the order reference; an unmatched row goes to a review queue.

As with the Card Uploader mapping above, this skeleton is seeded into `settings.import_mappings.ebay_orders` by the same Phase 4 migration, and that settings field, not this file, is what `POST /api/vault/imports/ebay-orders` reads.

## eBay listing export

`GET /api/vault/exports/ebay-listings.csv?ids=<comma list>`: a listing file for the given in-stock items, ebay.co.uk in GBP. There was no real eBay File Exchange export on hand to check this against when this file was written (the Card Uploader export above already covers the shop's primary eBay listing path for singles), so this is a deliberately plain subset of eBay's own bulk-listing column set, close to its real column names so a real File Exchange template can be diffed against it later, but leaving blank whatever we have no reliable source for rather than guessing: `Category` (an eBay numeric category id - Seller Hub's own category match is more reliable than a guess from our `games`/`kind`) and `ConditionID` (eBay's condition ids are picked per category and unconfirmed here) are both always blank, exactly like the SumUp mapping leaves `Variations`/`Option set 1-4`/`Modifiers`/`Display colour` blank for fields it has no data for.

| Column | Our source |
|---|---|
| Action(SiteID=UK\|Country=GB\|Currency=GBP\|Version=1193) | Always `Add` |
| Custom label (SKU) | `items.ebay_sku` when set, else our own SKU |
| Title | `items.title`, cut to eBay's 80-character limit |
| Description | Set code and condition, space separated |
| Category | Left blank; picked in Seller Hub |
| ConditionID | Left blank; picked in Seller Hub |
| Format | Always `FixedPrice` |
| Duration | Always `GTC` (Good 'Til Cancelled) |
| StartPrice | `items.price` formatted as a plain decimal, pounds and pence, no £ sign |
| Quantity | `items.qty` |
| ImageURL | The item's first photo, as this server's own `/api/files/...` path, when it has one |
| Location | `settings.shop_town` |
| PostalCode | `settings.shop_postcode` |

An id that does not exist, or is not `in_stock`, is left out of the file rather than failing the whole export; nothing on `items` is changed by this route ("marking nothing" in docs/PLAN.md's Screens section - unlike the SumUp export, there is no `..._synced_at` to set, since there is no round trip back from a plain listing file the way there is from Card Uploader's own eBay export).

## End-listings export

`GET /api/vault/exports/end-listings.csv`: every item with an `ebay_listing_id` whose `status` is `sold`, so the listings can be ended on eBay by hand (there is no eBay API write access in this build - Card Uploader's Managed Inventory or Seller Hub itself ends the listing). Columns: SKU, Title, eBay listing ID, eBay SKU, Sale date, Sale number. `POST /api/vault/items/end-listings` with `{ "ids": [...] }` then clears `ebay_listing_id` and `ebay_sku` on each once the listing is actually ended, so the same item does not appear on this list again.

## Our exports

**Inventory export** (`items`): SKU, Kind, Game, Title, Set code, Number, Finish, Language, Condition, Completeness, Cosmetic grade, Tested, Region, Grade company, Grade, Certificate number, EAN, Quantity, Cost, Market value at intake, Sell price, Tax scheme, Status, Location, Source, Acquired date, Supplier reference.

**Sales export** (`sales` and `sale_lines`): Sale number, Date, Staff, Customer, SKU, Item title, Quantity, Unit price, Discount, VAT rate, Tax scheme, Payment method, Sale total, Line status.

**Buy-in register export** (`trade_ins` and `trade_in_lines`, with the seller snapshot): Trade-in number, Date, Staff, Customer, Seller name, Seller address, ID type, ID last four digits, ID expiry, Item description, Condition, Quantity, Market price, Offer price, Payout type, Cash amount, Credit amount, Signature reference. One row per line; Payout type, Cash amount and Credit amount are the whole trade-in's own figures, repeated on every line of it the same way the stock book repeats its purchase columns, since a mixed payout is not split per line anywhere in the data model.

**Stock book export** (the VAT margin scheme record): Stock number, Purchase date, Purchase reference, Seller name, Seller address, Description, Cost, Sale date, Sale reference, Sale price, Margin.
