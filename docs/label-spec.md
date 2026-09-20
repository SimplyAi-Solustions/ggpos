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

## Printing path 2: WebUSB TSPL2, as built

A WebUSB sender running in the counter PC's Chrome talks TSPL2 straight to the printer, driven by the `label_jobs` queue. A phone in the back room queues a label and the counter PC prints it, with no driver on the phone and nothing keyed twice.

**The commands.** `apps/web/src/features/printing/tspl.ts` turns the same `labelLayout` result the browser print page draws into the bytes the T003 reads, so the two paths can never drift:

```
SIZE 40 mm,20 mm
GAP 2 mm,0 mm
DENSITY 8
CODEPAGE 850
CLS
QRCODE 12,28,L,5,A,0,"GGS7F3K2B"
TEXT 129,39,"2",0,1,1,"Charizard ex"
TEXT 129,64,"1",0,1,1,"SV151 199/165 Holo"
TEXT 129,81,"1",0,1,1,"NM"
TEXT 129,98,"3",0,1,1,"£324.99"
TEXT 292,136,"1",0,1,1,"GG"
PRINT 1,1
```

- Every position is in dots, converted once from the layout's millimetres at 203 dpi (`DOTS_PER_MM`).
- `CODEPAGE 850` is what makes the pound sign a single byte, `0x9C`. Everything else goes out as ASCII: an accent, a curly quote or a middot in a title is written in the plain letters it stands for, control characters are dropped, and `"` and `\` are escaped, so nothing in a card name can ever be read as a command.
- Type is set in the printer's own bitmap fonts (`1` at 8 x 12 dots up to `4` at 24 x 32), choosing the font and multiplier nearest the millimetre size the layout asked for and preferring a larger cell over a blown-up small one. A line longer than its column is cut with a plain ellipsis rather than left to run off the label.
- The QR cell is sized so the symbol lands on the size in the table above: 21 modules at 5 dots is 105 of the 110 the 40 x 20 label asks for, and a customer card's portal link is a bigger symbol at a smaller cell.
- The G mark is a drawn shape, so a thermal label carries the two letters it stands for, in the smallest font, in the corner the browser path puts the mark in.

**The sender.** `features/printing/usb.ts` asks for a device with no vendor filter (the T003's ids are not published), opens it, selects the first configuration, claims the interface whose class is 7, or else the first with a bulk OUT endpoint, and writes the bytes to it. Chrome remembers the permission, so `getDevices()` finds the printer again the next morning with nothing to press. Failures are reported in words: no WebUSB in this browser, the driver not bound on Windows, a device that is not a printer, and a cable pulled out part way through a label.

**The queue.** The Labels screen claims jobs through `POST /api/vault/labels/claim` under the device's own name (`Counter PC` unless it is renamed), prints each one and marks it printed or failed. A realtime subscription on `label_jobs` is the quick trigger and a five-second poll runs underneath it. A job another device is holding reads "Printing on <device>"; three failed attempts leave it `failed` with the reason, and "Queue again" puts it back. A device can be told which roll is loaded, in which case it claims only labels that size and leaves the rest for whoever has that roll on.

### Setting the counter PC up on Windows

macOS, Linux and ChromeOS need none of this: Chrome can open the printer as it is. Windows will not let a browser open a device that is bound to a vendor driver, so the T003 is bound to WinUSB first.

1. Print a test label through the Windows driver first, so it is known to work, then close anything holding the printer (the driver's own queue, any label software).
2. Download Zadig (zadig.akeo.ie), run it as an administrator, and tick Options, then List All Devices.
3. Pick the T003 in the list. Check the USB id shown matches the printer and not another device.
4. Choose **WinUSB** as the driver to install, and press Replace Driver. It takes a few seconds.
5. Open Chrome, go to the Labels screen, press Connect printer and pick the T003 in the list Chrome shows. Chrome asks once per device, per browser profile, and remembers it after that.
6. Turn Auto-print on. The switch is remembered, so the counter PC picks the queue up again by itself after a restart.

Binding WinUSB replaces the Windows driver for that device, so printing path 1 (the browser print dialog) stops working on that PC until the driver is put back through Device Manager. Decide which path the counter PC is on rather than switching between them.

## Scanner configuration

A USB 2D keyboard-wedge scanner, for example a Zebra DS2208 at about £80, or an Eyoyo or NETUM 2D model at about £30 to £45. Configure it to send a prefix character before the scanned data and an Enter (CR) suffix after it, so the app's global scan listener can tell a scan apart from a staff member typing in a field, and submit automatically on the Enter. Check the scanner's own configuration manual for its prefix-character barcode; a rarely-typed character such as Tab is a reasonable choice if the model allows one to be set. A 1D-only laser scanner will not read the QR codes this system uses and should not be ordered.

## Recommended label stock

Die-cut direct thermal labels, 25 mm core, in the four sizes above, gap-sensing (TSPL `GAP`) rather than black-mark. Removable adhesive for the 40 × 20 top-loader stock, so a label lifts cleanly off a top loader without leaving residue or damaging the sleeve; permanent adhesive for the sleeve, boxed retro and customer card sizes.
