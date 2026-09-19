# CSV formats

Column layouts and mapping configs for every CSV GG Vault reads or writes. See `docs/PLAN.md` ("SumUp integration", "Card Uploader and the eBay round trip") for the background.

## SumUp item import

SumUp's own CSV import, used to push retail lines into SumUp so they can be sold through the SumUp app, accepts these columns:

Item name, Description, Category, Price, SKU, Barcode, Quantity, Tax rate (%), Variations, Option set 1, Option set 2, Option set 3, Option set 4, Modifiers, Display colour.

## Our SumUp export mapping

GG Vault only exports **retro and sealed lines** to SumUp. Trading card singles are not listed individually; they are rung through SumUp as a single generic "single card" line with a keyed price, because listing every card individually is impractical. Our export writes:

| SumUp column | Our source |
|---|---|
| Item name | Our SKU, then the item title, for example `GGP-7F3K2Q Charizard ex Booster Box`, so a SumUp sale can be matched back to our SKU by eye |
| Description | Game, set and condition detail |
| Category | Game or kind |
| Price | `items.price` formatted as a plain decimal, pounds and pence, no £ sign |
| SKU | Our SKU |
| Barcode | Our SKU, or the item's EAN for sealed product and accessories |
| Quantity | `items.qty` |
| Tax rate (%) | Derived from `items.tax_scheme` |
| Variations, Option set 1 to 4, Modifiers, Display colour | Left blank; not used |

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

## eBay orders import

Marks an item sold, with the order reference, once it has sold on eBay. Skeleton mapping, also to be confirmed against a real export:

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

## Our exports

**Inventory export** (`items`): SKU, Kind, Game, Title, Set code, Number, Finish, Language, Condition, Completeness, Cosmetic grade, Tested, Region, Grade company, Grade, Certificate number, EAN, Quantity, Cost, Market value at intake, Sell price, Tax scheme, Status, Location, Source, Acquired date, Supplier reference.

**Sales export** (`sales` and `sale_lines`): Sale number, Date, Staff, Customer, SKU, Item title, Quantity, Unit price, Discount, VAT rate, Tax scheme, Payment method, Sale total, Line status.

**Buy-in register export** (`trade_ins` and `trade_in_lines`, with the seller snapshot): Trade-in number, Date, Staff, Customer, Seller name, Seller address, ID type, ID last four digits, ID expiry, Item description, Condition, Quantity, Market price, Offer price, Payout type, Cash amount, Credit amount, Signature reference.

**Stock book export** (the VAT margin scheme record): Stock number, Purchase date, Purchase reference, Seller name, Seller address, Description, Cost, Sale date, Sale reference, Sale price, Margin.
