# Label spec

Specification for every barcode label and the customer QR card GG Vault prints on the counter's ORGSTA T003. Read alongside `docs/PLAN.md` ("Labels (ORGSTA T003)") and `packages/shared/src/sku.ts`, which is the authoritative code format.

## Sizes

| Label | Size | Used for |
|---|---|---|
| Top loader / unboxed retro | 40 × 20 mm | Trading card singles and graded slabs in a top loader; loose retro cartridges and discs |
| Sleeve | 25 × 15 mm | Sleeved singles and small accessories |
| Boxed retro | 50 × 30 mm | Boxed retro games and consoles |
| Customer card | 80 × 50 mm | The customer's QR loyalty card (a wallet PDF is the alternative for a customer who wants a digital copy) |

All four are die-cut direct thermal labels on a 25 mm core, printed at 203 dpi.

## Pixel dimensions at 203 dpi

203 dpi is approximately 8 dots per mm (203 / 25.4 = 7.99). Figures below are rounded to the nearest whole dot, matching the render size used by the print template.

| Label | Size (mm) | Pixels at 203 dpi |
|---|---|---|
| Top loader / unboxed retro | 40 × 20 | 320 × 160 |
| Sleeve | 25 × 15 | 200 × 120 |
| Boxed retro | 50 × 30 | 400 × 240 |
| Customer card | 80 × 50 | 640 × 400 |

## Symbology

QR everywhere, not Data Matrix: phone cameras and every 2D scanner read a QR code, and native camera apps generally do not decode Data Matrix.

| Label | QR size |
|---|---|
| Top loader / unboxed retro (40 × 20) | About 110 px, positioned on the left third of the label |
| Sleeve (25 × 15) | 11 mm, about 88 px, sized for the in-app camera scanner or a USB 2D scanner held close |
| Boxed retro (50 × 30) | Recommended about 150 px on the left, scaled up from the 40 × 20 layout for the larger label; confirm against a real print before finalising the template |
| Customer card (80 × 50) | Recommended about 260 px, large enough for a customer to scan their own screen or a printed card at arm's length; confirm against a real print before finalising the template |

## What goes on each label

**Top loader / unboxed retro (40 × 20):** QR on the left. To its right: item title, then set code, number and finish in mono, a condition badge (NM, LP, MP, HP or DMG), and the price. A small "GG" mark completes the label.

**Sleeve (25 × 15):** QR only, sized for a close scan, with the item code printed beneath in small mono type. There is not enough room for a title or price at this size; staff rely on the scan to bring up the item.

**Boxed retro (50 × 30):** the same layout as the 40 × 20 label with more room: QR on the left, then title, platform, region and condition on the right, with the price. Larger type than the 40 × 20 label, since the label itself is larger.

**Customer card (80 × 50):** a QR encoding the customer's portal link (see "The code format on labels" below), the customer's name, their code in mono type, and their current tier. The "GG" mark appears once, small, in a corner.

## The code format on labels

Every item, customer and reward code follows the shape in `packages/shared/src/sku.ts`: `GG` + a one-letter kind + 5 body characters + 1 check character, all from the Crockford base32 alphabet (no I, L, O or U, so a scanned or handwritten code is never ambiguous). Displayed with a hyphen after the kind letter, for example `GGS-7F3K2Q`; encoded without the hyphen for a QR code, `GGS7F3K2Q`.

Kind letters:

| Letter | Kind |
|---|---|
| S | Single |
| G | Graded |
| R | Retro |
| P | Sealed product |
| A | Accessory |
| X | Other |
| C | Customer |
| V | Reward voucher |

Note the reward voucher letter is **V**, not R: `docs/PLAN.md` refers to reward codes loosely as "GGR" in places, but the shipped code in `sku.ts` gives retro items the letter R and reward vouchers their own letter, V, so the two never collide. A printed reward code reads `GGV-xxxxxx`.

Item and reward labels encode the bare code, no hyphen, in the QR, for example `GGP7F3K2Q`, so the counter's scan listener can read it directly and route by the kind letter. The **customer card is different**: its QR encodes a full portal link, `https://vault.ggentertainment.co.uk/c/<qr_token>`, using the customer's rotatable token rather than their printed code, so a phone camera opens the portal directly. The customer's `GGC-xxxxxx` code is printed as text on the same card for manual lookup and for staff to type at the counter.

## Printer

ORGSTA T003: direct thermal, TSPL2 command language, handles label stock from 20 to 80 mm wide, 203 dpi, USB and Bluetooth. Only USB is used for printing in GG Vault; Bluetooth printing from a browser is not viable, so the Bluetooth radio goes unused.

## Printing path 1: browser print, day one

`/labels/print?job=…` renders the label with `@page { size: 40mm 20mm; margin: 0 }` (or the matching size for the label template), one label per printed page. The counter PC has the T003's Windows driver installed and runs Chrome with `--kiosk-printing`, so printing a label is one click with no print dialog. This is the default path from launch.

## Printing path 2: WebUSB TSPL2, later phase

A WebUSB sender running in the counter PC's Chrome talks TSPL2 directly to the printer (`SIZE`, `GAP`, `DENSITY`, `CLS`, `QRCODE`, `TEXT`, `PRINT`), driven by the `label_jobs` queue. This lets a phone queue a label that the counter PC then prints, without the phone needing its own driver. Windows needs the WinUSB binding set up through Zadig first (see the deployment runbook); macOS, Linux and ChromeOS work without that step.

## Scanner configuration

A USB 2D keyboard-wedge scanner, for example a Zebra DS2208 at about £80, or an Eyoyo or NETUM 2D model at about £30 to £45. Configure it to send a prefix character before the scanned data and an Enter (CR) suffix after it, so the app's global scan listener can tell a scan apart from a staff member typing in a field, and submit automatically on the Enter. Check the scanner's own configuration manual for its prefix-character barcode; a rarely-typed character such as Tab is a reasonable choice if the model allows one to be set. A 1D-only laser scanner will not read the QR codes this system uses and should not be ordered.

## Recommended label stock

Die-cut direct thermal labels, 25 mm core, in the four sizes above, gap-sensing (TSPL `GAP`) rather than black-mark. Removable adhesive for the 40 × 20 top-loader stock, so a label lifts cleanly off a top loader without leaving residue or damaging the sleeve; permanent adhesive for the sleeve, boxed retro and customer card sizes.
