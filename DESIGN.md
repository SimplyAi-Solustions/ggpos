# GG Vault design system

The staff and customer web app for GG Entertainment, Bolsover. This file records
the system as built in `apps/web`, not as planned: every token, component and
rule below exists in code and is shown on the kit page.

- Kit page: run `pnpm --filter web dev` and open `/kit`; `/` is the app's
  front door and sends you to the counter or to sign-in. Both rebuilt
  reference screens are sections on that page, next to the PNGs they were
  built from.
- Visual targets: `docs/design-references/atlas-scan-item.png`,
  `docs/design-references/nova-add-item.png`,
  `docs/design-references/atlas-details.png`. Every critique pass compares
  against these three. They are also served to the kit page from
  `apps/web/public/kit/`.
- Source of the brief: `docs/PLAN.md`, sections "Brand inputs" and
  "UI system: minimal, on brand".

The look in one line: an off-white paper canvas with a faint grain, ink text,
hairline underlines instead of boxes, tracked Space Mono micro-labels, one Anton
line per screen, and GG yellow used five times and no more.

---

## 1. Tokens

All colour is oklch, declared in `apps/web/src/design/theme.css` and mapped to
shadcn's names through `@theme inline`. `apps/web/src/index.css` imports
Tailwind, `tw-animate-css`, `shadcn/tailwind.css` and then the theme, in that
order. Light is the default; `.dark` on `<html>` is counter night mode.

### Colour

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--background` | `#fbfbfa` | `#0b0b0b` | The canvas. Nothing else is a surface. |
| `--foreground` | `#0b0b0b` | `#fbfbfa` | Body and heading text. |
| `--muted-foreground` | `#3d3d3a` | `#c9c9c2` | Field labels, ledes, table meta. |
| `--muted-foreground-2` | `#73736d` | `#8f8f88` | Placeholders and helper text. |
| `--primary` | `#0b0b0b` | `#fbfbfa` | The block and circle buttons, selected chips. |
| `--primary-foreground` | `#ffffff` | `#0b0b0b` | Labels on those buttons. |
| `--primary-hover` | `#1f1f1d` | `#e8e8e2` | Block hover. |
| `--secondary`, `--surface-2`, `--row-hover` | `#f3f3ef` | `#1f1f1d` | Table row hover, ghost icon hover. |
| `--surface-3` | `#e8e8e2` | `#262623` | Switch track when off. |
| `--accent`, `--ring`, `--volt` | `#fedf01` | `#fedf01` | The single accent. |
| `--volt-deep` | `#e3c700` | `#e3c700` | Volt pressed, held in reserve. |
| `--pop` | `#ff2e6b` | `#ff2e6b` | Error underline, expiring offers. |
| `--destructive` | `#c4174c` | `#ff2e6b` | Error text. |
| `--border`, `--input`, `--hairline` | ink 24% | paper 26% | The input underline. |
| `--hairline-soft` | ink 12% | paper 14% | Table rows, panel edges. |
| `--hairline-faint` | ink 6% | paper 8% | Dividers inside the kit. |
| `--silhouette` | ink 4% | paper 6% | Product image placeholder. |
| `--product-edge` | ink 12% | paper 14% | Box art stroke. |
| `--product-edge-offset` | ink 20% | paper 22% | The printed-edge offset line. |
| `--chart-1` to `--chart-5` | ink, `#3d3d3a`, `#73736d`, `#e8e8e2`, volt | inverted, volt unchanged | Charts. A series is ink; a comparison series is `--chart-3` (4.6:1 on paper, so it can be seen); at most one series is volt; `--chart-4` is for gridlines and empty heatmap cells only, never a series. |

Two deliberate departures from the brief, both recorded here so nobody
"corrects" them back:

1. The brand's third grey `#7a7a74` is 4.17:1 on the `#fbfbfa` canvas, which
   fails WCAG AA for body text. `--muted-foreground-2` is `#73736d` instead,
   at 4.61:1. Use `#7a7a74` only for non-text marks if you ever need it.
2. `--pop` (`#ff2e6b`) is 3.46:1 on the canvas. It passes the 3:1 bar for
   non-text, so it draws the invalid field's underline, but error **text** uses
   `--destructive` (`#c4174c`, 5.68:1). In dark mode `--destructive` becomes
   pop, which is 5.49:1 on ink.

### Where volt is allowed

Six places, and nowhere else: the G mark, the focused field's underline and
the active nav underline, points and tier badges, the done seal, the focus
ring, and the bar a scan flashes along the row it landed on (`useScanPulse`,
section 6). The sixth is on the list because it does the focus ring's job, in
the one place the app has to say "this, here, now" to somebody who is looking
at a customer rather than the screen; the plan asks for it in those words
("a successful scan pulses the target row's underline in volt"). Volt is never
a background for text unless the text is ink. White on yellow never appears.

### Radius, shadow, grain, easing

- `--radius: 4px`. The whole radius scale collapses onto it, so any leftover
  shadcn `rounded-3xl` is 4px. Pills (chips, switch, avatar, badge) use
  `rounded-full`. Everything else is square.
- `--shadow-panel: 0 1px 2px rgba(11,11,11,.04), 0 24px 48px rgba(11,11,11,.08)`.
  Sheets, dialogs and select popups. Product images have their own drop shadow.
  Nothing else has a shadow.
- Paper grain: an inline `feTurbulence` SVG at 3% opacity on a fixed
  `body::before`, in both modes. It does not scroll.
- `--ease-gg: cubic-bezier(.16, 1, .3, 1)`, the marketing site's out-expo.

---

## 2. Type

Three faces, self-hosted through Fontsource. Poppins does not appear in the app,
and neither does Inter or any system sans.

| Role | Face | Size and weight | Token |
| --- | --- | --- | --- |
| Page title | Anton 400 | `clamp(28px, 1.4rem + 1.6vw, 36px)`, .01em, uppercase | `--font-display` |
| KPI figure, offer total | Anton 400 | 28px, .01em, `tnum` | `--font-display` |
| Micro-label | Space Mono 700 | 11px, .16em, uppercase | `--font-mono` |
| Code, SKU, timestamp | Space Mono 400 | 13px, `tnum` | `--font-mono` |
| Outcome code (a buy-in or sale number shown once as the result of a step) | Space Mono 400 | 20px, `tnum` | `--font-mono` |
| Scan field | Jost 300 | 24px on phones, 28px from 640px | `--font-sans` |
| Body, inputs, table cells | Jost 400 | 16px (15px in dense rows), 1.5 | `--font-sans` |
| Emphasis, chips | Jost 500 | 13px to 15px | `--font-sans` |
| Secondary money figure (a line offer, a balance beside a name) | Jost 500 | 20px, `tnum` | `--font-sans` |

Rules:

- One Anton line per screen. That single line is what makes a monochrome page
  read as GG rather than as a template. Never two.
- Every tracked uppercase label is Space Mono 700 at 11px. Keep them under about
  24 characters: uppercase at length is hard to read, and the Impeccable
  detector will say so.
- Money and counts carry the `.tnum` utility so columns line up.
- Money is never set in Space Mono, and a code is never set in Jost. Mono is for
  labels and codes; the big figure is Anton; every other amount is Jost.
- Body measure is capped: `Lede` is 56ch, kit notes are 64ch.

---

## 3. Spacing and layout

- Content column: 1,040px max, 40px gutters from 640px, 20px below. On the
  counter screens the header, content and footer all share that column, so
  the wordmark, the first section heading and the primary button sit on one
  left edge.
- Top margin above the first section: 96px on desktop, 64px on phones.
- Between sections: 96px of whitespace. Sections are never divided by a rule,
  a card or a box.
- Section heading to first control: 28px. Field label to control: 6px.
  Between stacked fields: 40px.
- Forms are label-left from 900px with a 160px label column and a 24px gutter,
  and stack to label-above below that. `Field` does this; do not hand-roll it.
- Navigation: wordmark top left, text links with a 2px volt underline on the
  active one, avatar top right. No sidebar. On phones the nav links drop and a
  bottom bar of five thin icons with Space Mono labels takes over.
- On phones the primary action docks to the bottom in the thumb zone, and every
  secondary action is a bottom sheet. Targets are at least 48px.
- My Vault (`/account`) is built for one person in one hand, so its column is
  560px, not 1,040px, with the same 20px gutters below 640px and 40px above.
  The header carries the "My Vault" wordmark and the notification bell only.
  Its bar has six slots, Card, Book, Quotes, Wants, Credit and Me: below 900px it
  is fixed to the bottom with a hairline top edge and the safe-area inset, and
  the screen's one block button sits directly on top of it as one fixed group
  (`usePortalDock` in `features/portal/dock.ts` gives a screen the slot to
  portal its button into; the shell publishes the group's measured height as
  `--gg-portal-dock-h`, and the column pads by exactly that). From 900px the
  same five become text links under the header with the nav's volt underline,
  the button returns to the flow, and the micro-copy footer comes back.
- The customer display (`/display`, a tablet on the counter signed in as
  staff) is the one screen a customer reads from a distance. Idle: the logo
  lockup, one Anton line, the sign-up QR, and the shop's ticker as a single
  slow band in volt with `◆` separators along the bottom edge, the one place
  the site's ticker appears in the app (it stops under
  `prefers-reduced-motion`). During a sale: the basket lines with product
  images, the discount line, the total in Anton, "Earns N points". During a
  buy-in: the offer lines, what they sell for, the offer in Anton, the
  payout sentence, and one Accept block button at 72px, the only button on
  the screen, followed by the done seal. The customer's name is shortened
  to a first name and an initial; no balance, code, phone or email ever
  reaches this screen. No navigation and no idle lock. Both colour modes.

---

## 4. Components

All in `apps/web/src/components/ui/`, shadcn-style: a named export per part,
`data-slot` attributes, typed props, `cn` merging. `apps/web/eslint.config.js`
already exempts this folder from `react-refresh/only-export-components`.

| Component | When to use it |
| --- | --- |
| `Input` | Every single-line field. Underline only: 1px hairline, 1.5px volt on focus with an ink caret, 1.5px pop when `aria-invalid`. No box, no radius, no fill, no left padding. Props: `leadingIcon` (20px at 1.25 stroke, 12px gap), `trailingHint` (Space Mono micro-text, right aligned), `size="default" \| "scan"`. The scan size is the biggest thing on a counter screen and drops its hint on phones so the placeholder is not truncated. |
| `BarcodeGlyph`, `RingSpinner` | The barcode bars used as a leading icon, and the thin loading ring. Exported from `icons.tsx` and re-exported from `input.tsx`. |
| `Textarea` | Multi-line notes. Same underline, grows with its content, `trailingHint` for a character count. |
| `Select` | A choice from a short list. Same underline plus a 1.25 stroke chevron that flips when open. The popup is a paper panel: hairline edge, 4px radius, `shadow-panel`. |
| `Switch` | A binary setting. Ink track when on, `#e8e8e2` when off, paper thumb, with a 48px hit area below 640px that does not change its drawn size. Never volt. |
| `Button` | `block` is the one primary action per screen: a 56px black block, Space Mono 700 uppercase .16em at 12px, minimum 176px wide, optional trailing arrow. `circle` is the same action as a 56px disc beside a `MicroLabel`. `text` and `text-destructive` are the secondary and destructive links, with an underline that grows from the left on hover. `ghost-icon` is a bare 40px icon target. `loading` swaps the arrow for the ring and blocks further presses. |
| `Button variant="key"`, `size="till"` | `key` is the till's choice key: tenders, receipt choices, quick cash notes. A 4px hairline-edged block on the canvas with the block's tracked label in ink, ink fill when `aria-pressed`. Several sit side by side, so none is the screen's one black block. `size="till"` makes a `block` or a `key` 72px tall, on the till, the lock screen and the customer display only. |
| `Keypad`, `PinDots`, `applyKey` | The till's number pad (`components/ui/keypad.tsx`): twelve 72px keys drawn as a grid of hairlines, Jost 300 digits at 32px. `mode="pin"` has Clear and Backspace beside 0, `mode="money"` has 00 and Backspace. `captureKeyboard` takes digits from the Mac's keyboard too. `PinDots` draws a PIN's progress as ink dots, never digits. `applyKey` is the next value for a key press. |
| `Chip`, `ChipGroup` | Condition, finish, rarity, filters. Hairline pill, Jost 500 13px, ink fill with paper text when pressed, 32px tall and 48px below 640px (the pill grows rather than taking an invisible hit area, because chips wrap and an overlay would send a tap to the wrong row). `ChipGroup` is a Base UI toggle group: arrow keys move, `multiple` allows several. Never yellow. |
| `MicroLabel`, `SectionHeading`, `Hint` | The three micro-text tones: label (`#3d3d3a`), section heading (ink, 32px above), helper (`#73736d`). |
| `PageTitle`, `Lede` | The one Anton line and its single grey sentence, 56ch maximum. |
| `Field`, `FieldRow`, `FieldError` | The only form layout. Owns label, hint, optional icon column, control and error. `FieldError` takes a react-hook-form message and renders one line under the control. |
| `Table` and parts | Hairline rows at ink 12%, Space Mono column headings, no zebra, no outer border, hover to `#f3f3ef`. `numeric` on a head or cell right-aligns it with `tnum`. `TableImageCell` is the 40px product image in the first column. `TableBody settle` with `TableRowSettle` rows adds the list entrance, for a body whose rows arrive together under a static query key. |
| `Sheet`, `Dialog` | Paper panel, 1px hairline edge, one soft shadow, 4px radius. Sheets dock to the bottom on phones whatever `side` says. A dialog is only for a task that needs protected focus; everything else is a sheet. |
| `Badge` | `volt` for points and tier (ink on yellow), `outline` for everything else, `count` (paper on ink) only for the unread count on My Vault's bell. A count is not an achievement, so it is never volt. |
| `Kbd`, `KbdGroup` | Keyboard shortcuts, drawn rather than described. |
| `Avatar` | Initials in a 40px hairline circle, Space Mono. |
| `Wordmark`, `GGLogo`, `GMark` | "GG VAULT" in Space Mono 700 at 13px tracked .28em; with `mark` the logo lockup stands in for the GG and the letters read "VAULT" (a screen reader still hears the whole name). `GGLogo` is the GG Entertainment logo itself, the paper G and the volt G traced from `design/brand/logo.png` by `scripts/trace-logo.mjs`, each with the logo's thick ink outline drawn beneath its fill. The outline is the logo's own construction and the reason it stands out on white; it is the constant ink token, so on an ink surface (night mode, the app icon) it merges with the background and the lockup reads as the site's logo-dark with nothing to switch. `mono` fills both Gs with the text colour for one-colour printing. `GMark` is the volt G alone, same outline, for the places a lockup would not fit: the 40 x 20 mm label and the favicon. Neither ever carries meaning on its own. |
| `Seal` | The done seal: an 84px volt disc, 2px edge, 4px offset shadow, Anton "DONE" or a tick. Success screens only, once. This is the one place in the app with a zero-blur offset shadow, quoting the marketing site's `--shadow: 6px 6px 0 var(--ink)`. The edge and shadow follow the foreground so the seal survives night mode. |
| `StickerRing`, `StickerOrbit`, `StickerCards` | The site's doodles at a 4px stroke. Empty states, the customer card, and in My Vault the one call-to-action block a screen may carry (the sign-up pitch, the add-to-home-screen prompt, the demo note); nowhere else, and never on a counter screen's working surface. |
| `Skeleton`, `SkeletonText` | Loading drawn as hairline blocks. Never a spinner, never a shimmer gradient. |
| `Note` (in `features/portal/`) | The small grey line under a row or a figure in My Vault: Jost 13px at `#73736d`. It exists because two things a `Hint` cannot carry come up on every portal screen: money (never set in Space Mono) and a sentence longer than about 24 characters (an uppercase run that long stops being readable). A date beside a reference, a balance beside a hold, or a line about the email address is a `Note`; a tracked label is still a `Hint`. |
| `Timeline` (in `features/portal/`) | A quote's progress as a hairline rail with a 10px marker per step. The current step is the only one in ink at full weight, carries `aria-current="step"`, and is the only one with a sentence under it; reached steps are grey, unreached ones an outlined dot. A stopped step (declined, expired) keeps the same ink marker and says what happened in words, so status never rests on a colour. Steps come from the pure `timeline.ts` so the same order shows for every status. |
| `Tabs`, `Tooltip`, `Separator`, `Label`, `Toggle` | Restyled shadcn parts. Tabs use the same 2px volt underline as the nav. |
| `ShortcutOverlay` (in `app/`) | Every keyboard shortcut, drawn as `Kbd` keys rather than described, grouped under Go to, Find and Help, with one line under them saying Esc closes any sheet, dialog or menu. A key that needs a modifier is drawn with it (`KbdGroup`, Ctrl or Cmd by the machine), so the page never shows a key that is not the key. `?` opens it anywhere on the counter, never while the caret is in a field, never on a scanner's own keystrokes and never while another popup has the keyboard; Esc closes it, and it is in the command palette for anybody who reached for the mouse. The list is `app/shortcuts.ts` itself, so a key the counter gains and this page does not cannot happen. |
| `PasswordScreen` (in `features/auth/`) | Set a new password: the one Anton line, one grey lede, three stacked password fields (the current one, then the new one twice, the new one carrying the hint "At least 12 characters" so the rule is on screen before anything is typed) and the single black block button, laid out exactly as the sign-in screen it follows on from. Two ways in and one screen: a staff member whose account still carries `must_change_password` is held here by the counter's guard and gets `LockedShell` around it instead of the counter chrome, so there is no nav, no thumb bar, no palette, no shortcuts, no scanner and no idle lock until it is done; anybody else opens it from their own account menu and keeps the counter around them. The only thing that changes between the two is the lede, which says "This is your first sign-in" only when it is. Every refusal is a sentence under the field it belongs to, in the same words the server uses, with the cursor moved into that field and `aria-describedby` tying the two together, and the button says "Save and continue" because that is what it does: saves, signs back in, lands on Home. The button stays in the flow on a phone rather than docking to the thumb zone, the one counter screen that does: it is the sign-in and idle-lock shape, and in the locked state there is no bar under it to dock onto. |
| Label queue states (in `features/labels/`) | Where a job has got to is said in words under the item's title, never in a colour: "Printing on Counter PC" while another device holds it, the reason it stopped and which try it is on while it waits again, and the printer's own sentence with a "Queue again" action once it has failed three times. A failed job's reason is its own full-width row under the job, so the code, the size and the price keep their columns on a phone. The printer block above the queue is per device, not per shop: it names the roll that device has on (there is no "any", because one printer has one size of stock), and a browser with no WebUSB says "Queued for the counter printer" in one line and shows no controls at all. |

---

## 5. Product imagery

`apps/web/src/components/product-image/`, with the ratio table in
`apps/web/src/design/platforms.ts`. The table mirrors the `platforms` seed
collection in PocketBase; keep the two in step.

| Platform | Ratio | Default finish |
| --- | --- | --- |
| `tcg_card` | 63:88 | shadow |
| `graded_slab` | 82:135 | shadow |
| `gameboy_cart` | 57:65 | edge |
| `snes_pal_box` | 190:135 | edge |
| `n64_box` | 195:135 | edge |
| `megadrive_box` | 130:180 | edge |
| `ps1_case` | 142:125 | edge |
| `ps2_case` | 135:190 | edge |
| `gamecube_case` | 135:190 | edge |
| `switch_case` | 105:170 | edge |
| `gameboy_box` | 90:130 | edge |
| `etb` | 100:115 | edge |
| `booster_box` | 4:3 | edge |
| `booster_pack` | 63:105 | shadow |
| `console` | 4:3 | edge |
| `other` | 3:4 | edge |

Rules:

- Give `ProductImage` a `platform` (or an explicit `ratio`) and one of `height`
  or `width`. It computes the other, writes real `width` and `height` on the
  `<img>`, and nothing shifts while the page loads.
- The image is `object-fit: contain` on the canvas colour. Never on a grey tile,
  never cropped.
- **shadow** is for cut-outs with transparent corners: Scryfall PNGs, TCGdex
  WebP, Lorcast, graded slabs. It applies
  `drop-shadow(0 1px 1px rgba(11,11,11,.05)) drop-shadow(0 12px 24px rgba(11,11,11,.10))`,
  which follows the card's real rounded edge.
- **edge** is for printed box art and photographs: a 1px ink-12% stroke plus a
  1px offset line down the left and bottom at 20%, which reads as a printed
  card edge.
- While it loads, a silhouette of the frame's shape in ink at 4% covers the
  image and dissolves over 150ms. The image itself never renders at zero
  opacity, so a lazy or cached image can never end up invisible.
- `thumbUrl(fileUrl, width)` appends PocketBase's `?thumb=WxH` for files served
  from `/api/files/` and leaves external URLs alone. `thumbSrcSet` builds a
  `srcset` across 160, 320 and 640.
- Sources with a white background (YGOPRODeck, OPTCG, IGDB, staff photos) get a
  white-fringe trim in the photo tool before they are stored, so the edge finish
  reads cleanly.

---

## 6. Motion

`apps/web/src/design/motion.ts`. One easing, two durations, and a guard.

- Easing: `cubic-bezier(.16, 1, .3, 1)`. No bounce, no elastic, no spring.
- 150ms for a control you are touching, 200ms for something entering the page.
- `pageRise`: opacity 0 to 1, y 8px to 0.
- `listContainer` and `listItem`: 20ms between rows, y 6px.
- `underlineGrow`: scaleX 0 to 1 from the left. Inputs do this in CSS already.
- `panelRise`: sheets and dialogs, y 12px.
- `sealIn`: scale .94 to 1, no overshoot.
- `useCountUp(value, { decimals })`: a KPI figure counts up over 600ms
  whenever the figure arrives or changes, from what is on screen rather than
  from the last target. Home's four tiles use it: the figure counts from
  nothing to the day's total when the numbers land, and says "Not counted
  yet" until they do rather than counting up to a zero that would read as a
  quiet day. Under reduced motion it returns the figure itself, worked out
  during the render, so no tile ever paints a frame of £0.00.
- `useScanPulse()`: the line a scan has just put in the basket flashes a
  1.5px volt bar along its underline, the sixth use of volt in section 1. The
  bar grows from the left with `underlineGrow` and, inside an
  `AnimatePresence`, leaves the same way, 150ms each; the second it holds in
  between is state, not motion, so nothing breaks the 200ms budget. It is
  keyed on the scan and not on the row, so the same sealed line scanned three
  times flashes three times.
- `PageMain` (in `app/page-transition.tsx`) is `<main>` with the page
  entrance on it, keyed by the matched route's id, so a screen fades and
  rises once on arrival and not again when its own state changes. Both shells
  use it; no element is added between the content column and the screen. Two
  deliberate consequences are written on the component: a param-only move
  gets no entrance, and nothing inside a screen may be `position: fixed` and
  expect the viewport.
- `scanTick()` (in `app/scan-bus.ts`) vibrates the device for 30ms as a scan
  comes in, on `dispatchScan`, so every screen that takes a scan ticks: Sell,
  Scan, the stock count and the buy-in wizard's customer step. A desktop
  browser and a device with no motor have nothing to call, and a browser that
  refuses it outside a gesture cannot throw.
- `TableBody settle` plus `TableRowSettle` give a list the row settle: 6px up,
  20ms apart. The pairing is required: a settle row outside a settle body
  inherits its labels from `PageMain` and animates with the page instead.
  Put them on a body whose rows arrive together under a **static query key**
  (Trade, the kit's own table). Leave them off a list that grows a page at a
  time, and off one whose key carries a search box: the Customers table's key
  changes on every keystroke, so a settle there would replay the whole
  entrance under the caret, once per letter.
- `useMotionVariants(variants)` returns a still set when the reader has asked
  for less motion, so call sites never branch. `theme.css` also zeroes every
  animation and transition under `prefers-reduced-motion`.

---

## 7. Copy

- Short, specific labels. "Save item", not "Submit". "Clear all", not "Reset
  form".
- Sentence case for body copy and button text in prose; the micro-label
  treatment does the uppercasing in CSS, so write "Scan item", not "SCAN ITEM".
- No exclamation marks. No emoji. No "Oops", "Awesome", "Uh oh".
- Errors say what happened and what to do next: "Card not found in Scarlet &
  Violet 151. Check the number or add it manually."
- Every percentage on screen is written one way, through
  `formatPercent` in `apps/web/src/lib/format.ts`: the figure, no space, then
  the sign. A whole number carries no decimal (`10%`), because a dead
  trailing zero is a digit that means nothing, and anything finer carries
  exactly one place (`32.6%`). Give the string the `tnum` class wherever it is
  a figure rather than a word in a sentence, so the digits keep one width.
  Rounding goes through `roundHalfUp` from `@gg/shared`, never `Math.round`,
  which takes a negative half the other way. A figure that is missing or not a
  number returns an empty string, and the caller says what is there instead:
  nobody reads a confident "0%" off a field somebody is halfway through
  retyping. Never `10 %`, never `10 per cent`, never a raw `0.1`.
- UK English and GBP throughout. No em-dashes in prose; use a comma or a
  hyphen.
- Every string is reviewed against these rules on the pull request.

---

## 8. Anti-patterns

Enforced by the Impeccable detector
(`.claude/skills/impeccable/scripts/bin/linux-x64/impeccable detect <url|path>`)
and by review. The kit page and both rebuilt screens report zero findings at
1440x1200 and 390x844.

- No gradient text. Emphasis comes from weight or size.
- No glassmorphism, and no blur as decoration.
- No purple-to-blue gradients, and no gradient as a surface at all.
- No untinted grey. Every grey here is ink-tinted at hue 106.
- No grey text on a coloured background. Text on volt is ink.
- No nested cards. There are no cards: sections are divided by whitespace.
- No bounce or elastic easing.
- No default Inter, Arial or system sans. Three faces, self-hosted.
- No zebra striping, no outer table borders, no boxes around inputs.
- No zero-blur offset shadows except the done seal.
- No uppercase runs longer than about 24 characters.
- No functional text below 11px.
- No `<img>` that renders at zero opacity.
- Icons are Lucide at 1.25 stroke, 20px, never filled. No emoji as icons.

---

## 9. Accessibility

- Contrast: body and placeholder text clears 4.5:1 in both modes. The values are
  listed in section 1 and shown on the kit page's colour section.
- Focus: a 2px volt outline at 2px offset, plus a state change on the control
  itself (the underline thickens to 1.5px volt, a chip fills, a block darkens),
  so focus is never signalled by the ring alone. The volt ring is low contrast
  against the pale canvas; that is the brand's instruction, and the paired state
  change is why it still passes 2.4.7.
- Every control has a label, through `Field` or an `aria-label`.
- Status is never carried by colour alone: an invalid field gets a pop underline
  **and** a message; the active nav link gets a volt underline **and**
  `aria-current="page"`.
- Chip groups, tabs and selects are keyboard operable through Base UI.
- Selection, caret, focus ring and scrollbars are themed, not left to the
  browser.

---

## 10. The till

The till (`/counter/till`), the lock screen and cashing up are the shop's
everyday EPOS (`docs/EPOS-PLAN.md`). They keep every rule above: the canvas
and grain, ink on paper, hairlines rather than boxes, Space Mono labels, one
Anton line, volt in its six places and nowhere else. What changes is scale
and density, because the till is used standing up, with a thumb, on a
1180 x 820 Android tablet and a Mac, and is read from across a counter. The
two reference screens a till is checked against are the tablet at 1180 x 820
landscape and the Mac at 1440 x 900; a phone at 390 x 844 must still work.

### Frame

- The till is the one counter screen that is **full-bleed**. The counter
  shell drops its header, nav, footer, thumb bar and 1,040px column for
  `/counter/till*` and renders the screen alone; the wedge listener, the
  command palette, the shortcuts and the lock stay.
- **Till header**, 64px, hairline-soft bottom edge: the G mark (`GMark`,
  24px) linking back to Home; the register and session in Space Mono
  ("COUNTER" and "OPEN SINCE 09:02", or "CLOSED"); on the right the parked
  tickets count, the staff member's initials in an `Avatar`, a Lock key
  (`LockIcon`, 56px target) and a `Menu` for X report, Cash up, No sale,
  Paid in or out, Returns, Reports and Back to the counter.
- From 900px: **two panes**. The catalogue on the left takes the rest; the
  ticket on the right is 400px wide (440px from 1280px), divided from it by
  one vertical hairline-soft rule, full height. No panel colour: both panes
  are the canvas.
- Below 900px: the same two panes as two tabs under the header, "Items" and
  "Ticket", the ticket tab carrying its line count; the ticket's total and
  its Pay button dock to the bottom of both tabs.
- Every target on the till is at least 56px; keypad keys, tender keys and
  the Pay button are 72px (`size="till"`).

### Catalogue pane

- At the top, the scan field (`Input size="scan"`, barcode glyph, "Scan or
  search", hint "PRESS ENTER") and under it the **category rail**: one row of
  `Chip`s at 48px whatever the width, scrolling sideways, "Quick" first. The
  chosen chip is ink. A category is never volt.
- **Tiles** fill the space below in a grid of `minmax(136px, 1fr)` columns
  with 12px gaps. A tile is a 4px-radius hairline-soft outline on the canvas
  (the one place a till surface has an edge, because a touch target needs
  one), at least 136px tall: the `ProductImage` at 88px tall in its own
  ratio and finish, then the name in Jost 500 15px (two lines, then an
  ellipsis), then the price in Jost 500 15px `tnum`. Pressed, the tile tints
  to `--row-hover` for 150ms. A till product with no image shows its Lucide
  icon at 28px and 1.25 stroke in place of the image, never a grey box. An
  open-price product says "Key price" where the price would be. A stock line
  that is out shows "Out of stock" in `Hint` and is disabled.
- Search results replace the tiles with the same tiles, or with the
  hairline `Table` rows when the search is for serialised stock (singles,
  graded, retro), where the SKU and condition matter more than the picture.

### Browsing the category tree

- The rail shows the quick-key pages, then the tree's top-level branches,
  as the same chips. A branch opens its view in the catalogue pane: a
  "Back" `text` button (56px) and beside it the **breadcrumb**, Space Mono
  micro-labels separated by a 12px chevron, earlier steps as buttons and the
  last one ink with `aria-current`.
- **Folder tiles** come first: the till's tile with the branch's picture, or
  a Lucide folder at 28px and 1.25 stroke, the name, and "N in stock" in
  `Hint` (nothing when there are none). Then the branch's products and stock
  as the usual tiles, then "Load more".
- The **category picker** is a sheet (a bottom sheet on a phone): the
  breadcrumb, the level's branches as 56px hairline rows with the shelf count
  in Jost 13px `tnum` and a chevron where there is more beneath, a search
  across every path that shows each result's path with the matching levels in
  ink, the chosen branch's path in one line above the block, and "Choose this
  branch" as the block.
- The **Categories editor** (Settings) is an indented list, 16px a level below
  640px and 28px above, a chevron that turns 90 degrees to open a branch, an
  ellipsis menu per row, and a 40px drag grip in 56px rows. While dragging,
  the dragged row is at 60% opacity, a 2px ink line marks a drop beside a row
  and `row-hover` with an inset 1px ink ring marks a drop inside it, and one
  live sentence pinned at the top says what the drop will do.

### Ticket pane

- At the top, the customer: "Add customer" as a `text` button with the
  person icon, or once attached, the name in Jost 500 16px, the code in
  Space Mono 13px, the tier as a volt `Badge` and the points balance in
  Jost. Removing the customer is a `ghost-icon` cross.
- **Lines** are hairline rows: the title in Jost 400 16px (two lines at
  most), the SKU or "Till product" and any note in Space Mono 13px beneath,
  a quantity stepper (thin minus and plus, 48px each) for anything with a
  quantity above one, and the line total right-aligned in Jost 500 16px
  `tnum`, with the was-price struck through above it when discounted. A
  line just added flashes the scan pulse (`useScanPulse`). Tapping a line
  opens its sheet: quantity, discount (percent or pounds), price, note,
  Remove. A removed line is logged as a void.
- Under the lines, a ticket discount line and a VAT line (only when VAT
  registered), then "Earns N points" when a customer is attached, each a
  `MicroLabel` with the figure in Jost `tnum` on the right.
- The **total** is the screen's one Anton line: 40px on the tablet and the
  Mac, 32px on a phone, `tnum`, right-aligned over the Pay button. It is the
  largest type in the app because it is read across the counter.
- **Pay** is the one black block, 72px, the full width of the pane. Above it,
  three `text` actions: Park, Discount, Clear ticket.
- An empty ticket shows one grey sentence, "Scan an item or tap a tile",
  and nothing else.

### Paying

- Pay turns the catalogue pane into the **tender pane**; the ticket stays
  where it is, read-only, so staff and customer can both still see what is
  being paid for.
- The Anton line moves to the tender pane and becomes **what is left to
  pay** ("£40.00", with "TO PAY" above it as a `MicroLabel`). The ticket's
  total drops to Jost 500 20px. There is never a second Anton figure.
- Tenders are a row of `Button variant="key" size="till"`: Cash, Card,
  Store credit, Points, Voucher, and Trade-in from wave 2. Each opens its
  step under the row:
  - **Cash**: the quick notes (`key` buttons: Exact, then the next notes up
    from settings, such as £5, £10, £20, £50), the `Keypad` in money mode
    beside them on a tablet and under them on a phone, and the amount handed
    over in a scan-sized underline field. "Take cash" is the step's block.
  - **Card**: one sentence, "Key £40.00 on the Tide reader.", then the last
    four digits in a Space Mono 28px underline field (numeric keyboard,
    four characters) and two actions: "Approved" (the block) and
    "Declined" (`text`). Nothing on the screen suggests the till talks to
    the reader, because it does not.
  - **Store credit** and **Points**: the balance, the most that can go on
    this ticket, the amount with the keypad, and the block.
- Tenders taken are hairline rows under the tender keys ("Cash £20.00",
  "Card ending 4242 £20.00"), each removable until the sale completes. The
  amount left updates in Anton as each lands. When it reaches zero the sale
  completes on its own.
- **Done**: the `Seal`, the change due as the Anton line when there is
  change ("CHANGE" above "£10.00"), otherwise the sale number as the outcome
  code in Space Mono 20px; "Earns 120 points" in Jost; then the receipt
  choices as four `key` buttons, Print, Email, Gift receipt, No receipt; and
  "New sale" as the block. Choosing a receipt starts a new sale.

### Part-exchange and exchanges

- **Trade in** is a `text` action on the ticket beside Park and Discount,
  and in the till menu so it works on an empty ticket. It needs a customer
  first. It opens the **Trade-in panel** in the catalogue pane, the way Pay
  opens the tender pane: "TRADE-IN" as a `MicroLabel`, the customer's name
  and code, one grey sentence ("Valued at credit rates. What it is worth
  comes off the ticket."), then the buy-in wizard's own line entry (the kind
  chips, card search, condition and finish chips, retro fields, bulk lot,
  sources and the override sheet) and the lines added so far. Each line
  shows its credit offer, with the cash offer under it as a `Hint` label and
  a Jost figure. "Back to the items" is the `text` action that closes it.
- On the **ticket**, the trade is its own group under the lines: "TRADE-IN"
  as a `MicroLabel` with "Change" on the right, each line's title, its
  condition, set and number in Space Mono 13px, and its credit offer as a
  negative figure ("-£75.00"), then "TRADE-IN TOTAL". Goods brought back are
  the same under "RETURNED", with the original sale's number on the right and
  the reason in grey under the lines.
- The Anton total becomes **TO PAY**: the sale less the trade and the return.
  When the trade or the return is worth more than the ticket, one sentence
  above it says so ("The trade-in is worth £90.51 more than the ticket.") and
  the block reads **Settle** (a trade covers it), **Refund** (a return is
  worth more) or **Exchange** (a return covers it exactly).
- **Settle** replaces the tender pane. Its Anton line is **TO THE CUSTOMER**,
  what they walk away with, and one sentence says how the ticket was paid.
  "PAY THE SURPLUS AS" offers two 72px choices, Store credit and Cash, each
  with its figure in Jost 500 under it and a `Hint` line ("Earns 453 points.
  No ID needed.", "At the cash rate. Needs photo ID unless it is on file.").
  The chosen one fills ink, as a chip does. Cash adds the money keypad with
  the cash-rate figure suggested and the difference in words ("The £18.45
  difference stays with the shop."), then the wizard's own ID step unless the
  customer's ID is verified and in date. Every trade ends with the terms and
  the signature pad before the block.
- When something is still left to pay, the tender pane lists the trade-in
  and the exchange as fixed rows under "TAKEN" ("Part-exchange", "Exchange,
  Return from GG-S-000456"), which cannot be removed, and adds a **Trade-in**
  tender key for the terms and signature.
- **Done** adds one line per outcome in Jost: "Trade-in GG-BI-000123 paid
  £18.00", how a surplus was paid, and the refund reference with a "Print
  refund receipt" `text` action.
- The **customer display** lists trade and return lines after the basket at
  negative figures and shows what is left to pay; when a trade or a return
  covers the ticket, its one big figure is **Back to you** instead of a
  total of nothing.
- The **printed receipt** keeps the sale's own lines and total, and prints
  what was brought back and traded in after the tenders, under "BROUGHT
  BACK" and "PART-EXCHANGE".

### Lock screen and approval

- **Lock** is a full-screen paper panel over the till, not a dialog over a
  dimmed page. Top left, the register name as a `MicroLabel`; top right the
  time in Space Mono. "LOCKED" is the Anton line, with the lede "Tap your
  name and enter your PIN."
- The **roster** is a grid of 96px tiles: an `Avatar` at 64px with the
  initials in Space Mono 20px, the first name in Jost 15px under it. A
  member with no PIN or a locked PIN is shown, with "No PIN" or "PIN
  locked" in `Hint`, and opens the password sign-in instead.
- Tapping a name replaces the roster with the **PIN step**: the name, the
  `PinDots` for their PIN's length, and the `Keypad` in PIN mode, 72px
  keys, at most 320px wide, centred. The last digit submits; there is no
  Enter key. A wrong PIN clears the dots and says "That PIN is not right. 3
  tries left." under them in `--destructive`. "Use password instead" is a
  `text` button. "Back" returns to the roster.
- Switching user keeps the ticket exactly as it was.
- **Manager approval** is a `Dialog`, the one till task that needs protected
  focus: the sentence "A manager needs to approve this.", what it is in Jost
  ("Give a refund of £12.00"), the approvers who can (avatars, 64px), then
  the PIN step as above. On a phone it is the bottom sheet.
- An unregistered device shows no lock screen and no roster: the password
  idle lock, as before, and the till asks a manager to register the device.

### Cashing up

- Cashing up is a counter screen in the normal column, not full-bleed, so it
  reads like the rest of the counter's records. The page title is the Anton
  line ("CASH UP").
- **The count** is a hairline `Table`: one row per denomination, £50 down to
  1p, with the denomination in Jost 500, a count field (underline, numeric
  keyboard, 56px tall) and the row total right-aligned `tnum`. The running
  total sits under it in Jost 500 20px. On the tablet the `Keypad` in PIN
  mode sits beside the table and types into the focused count.
- The Z count is **blind**: nothing on the screen says what the drawer
  should hold until the count is saved. The report then shows the variance
  in words and figures ("£2.40 over", "£1.10 short", "Exact"), never in
  colour alone.
- The Tide card total is one money field with the sentence "From the Tide
  app, Payments, today's card total." under it.
- X and Z reports on screen are a 420px column laid out like the printed
  receipt: `MicroLabel` headings, Jost rows with figures right-aligned
  `tnum`, hairlines between groups. Print and Back are the actions.

### Receipts

Receipts are drawn for an 80 mm printer at 576 pixels, black on white, in
the app's own fonts: the shop name in Anton, labels and codes in Space Mono,
lines in Jost, the total in Anton, the receipt number as a Code 128 barcode
and the My Vault QR at the foot. No grey, no volt, no grain: thermal paper
has one colour.

---

## 11. Launch screens

Four packages added screens after the till: bookings, research and agents,
photos and the website switch, and the reports dashboard with VAT. They keep
every rule above, add no token, face or radius, and are built from parts
section 4 already has. Where a thing stands is said in words, never by colour
alone, and a server refusal is shown as the server's own sentence.

### Bookings

- `/counter/bookings` has three tabs, Day, Week and Events, with the day and
  tab in the address so coming back from the till lands where staff left.
  "New booking" (on Events, "New event") is the one block, docked in the
  thumb zone below 900px. A 13px line under the date bar says what just
  happened, in `--destructive` when it went wrong. Week is seven day columns
  from 900px.
- The **day grid** has a column per table, PC, console or room, 132px at the
  least, and the hours down a 56px rail in Space Mono 13px, 72px to the hour,
  ruled in `--hairline-faint`. Names and hours stay put while the grid
  scrolls inside itself, so the page never scrolls sideways. A 1px ink line
  marks now. A free slot draws nothing until it is hovered or focused, then
  tints to `--row-hover` with a 20px plus; tapping it starts a booking there.
- A **block** is a 4px-radius outlined box, a touch target like a till tile,
  sharing its column in lanes where two overlap. It grows from the name (Jost
  500 14px) to "4 players" or "Walk-in, on the clock", then its state in
  words ("Held", "Checked in") or what is left to pay ("£8.00 to pay"). Held
  is a dashed hairline; finished and no-show go grey. Checked in fills ink
  with paper text, the one block in use, as a chosen chip fills. An event
  fills the tables it takes on a `--secondary` tint, so the bookings drawn
  over it still read, "Event" in `MicroLabel` over its name. These are the
  grid's only fills.
- **Moving**: press a held or booked block and drag past 6px. A 1px dashed
  ink outline shows where it lands, snapped to the resource's slot, its
  length kept. On drop the block sits there at once; if the server refuses
  it goes back and the notice line says why in the server's words.
- A **station tile** is 188px wide, hairline-soft, 4px radius, the till
  tile's shape because it is pressed standing up. Tiles scroll sideways under
  "Stations" on today's day view: the name in `MicroLabel`, "Free till
  18:00" or, running, the clock in Space Mono and the charge in Jost ("0:42,
  £2.50"), and a 48px `key`, "Start" or "Stop".
- Payment is at the till, never on this screen. Take payment, and Stop on a
  station, put one line on the ticket and open the till; its meta, where an
  SKU sits, reads "Booking" in Space Mono 13px. The **Bookings tile** heads
  the first category, the calendar icon at 28px and "Pay or start" in `Hint`
  where a price would be; it opens a right sheet of the stations and "To pay
  today", a 56px `key` per way to pay ("Deposit £6.00").
- **Events** are hairline rows: date and time in Space Mono 13px, name in
  Jost 500 16px, "4 of 16 places left" in 13px grey, the fee at the right.
  The event sheet takes the counter's scanner, so a Guild card checks its
  holder in; a party past the places left goes on the waitlist, and the
  block says "Add to the waitlist".
- **My Vault** gains a sixth slot in its bar, Book: Card, Book, Quotes,
  Wants, Credit and Me, 65px each at 390, and six text links from 900px.
  `/account/bookings` is What and Day chips (the days scroll sideways), a
  "How many" stepper, then each resource with its rate and a `tnum` chip per
  free time. A tapped time opens "Your choice" under its row: the price in
  Jost 500 20px and a `Note`, "Paid at the till when you arrive. Nothing is
  taken now." The block ("Book it", "Enter") docks on the bar below 900px.
  A booking shows Cancel only before it starts and while nothing is paid.
- An empty state is one grey sentence that says what to do: "Nothing can be
  booked on this day: the shop is closed, or every table and station is
  switched off." The grid loads as a `Skeleton` its own height. Settings,
  Bookings acts at once, like Tills.

### Research

- "Search eBay sold" and "Ask an agent" are two `text` actions, 32px apart,
  under the price sources on a trade-in line, in price check and on the item
  page. The first opens ebay.co.uk's UK sold listings in a new tab; the
  second sends a request for an agent to claim and is disabled while one is
  open.
- A request reads as one line: "Research" in `MicroLabel` ink, where it
  stands in Jost 15px ("Waiting for an agent", "Gandalf is looking",
  "Gandalf found 3 sold") and the time in Space Mono 13px ("9 Oct, 14:02").
  It is read again every five seconds while open. It is always said in words.
- The comps follow: the agent's own sentence in 13px grey, then a
  hairline-soft row each, 44px at the least: the sold date in Space Mono
  13px, the listing's title and condition on one truncated 13px line, the
  price in Jost 15px `tnum` (GBP and nothing else) and "Listing" as a 13px
  underlined link. A done request's comps become UK sold comps on the card,
  so the sources above are read again and lead with them. "Cancel request" is
  `text-destructive`, shown only while it can still be cancelled.
- The Research list (`/counter/research`, from Home and the command palette,
  not the nav) is the one Anton line, a lede, chips for All, Open, Claimed
  and Done, and hairline rows of title, "Asked by Jo, 9 Oct, 14:02. Searched
  for ..." and the request as above. Home has one row for it under Waiting.
- Agents is a Settings section below the Save, acting at once. Each agent is
  a hairline row: name, "Switched off" in `Hint`, "Token works until 3 Dec
  2026. Last action 9 Oct, 14:02." in 13px, and `text` actions Actions, New
  token and Switch off (`text-destructive`), the last two confirming in the
  row in a sentence that says what stops. A token is shown once, in a sheet,
  in Space Mono 13px; closing the sheet forgets it.
- An agent's actions (newest first, from the audit log) are hairline rows:
  what it did in words ("Asked for research", "Completed research", "Added a
  UK sold comp"), the time in Space Mono 13px at the right, the detail in
  13px grey. Never a raw action code.

### Photos, scanning and the website switch

- **Take photo** is a bottom sheet at every width, from the item page and
  from the saved screen after Add stock (a `text` action under Print label).
  The first photo is the one the website shows, and the sheet says so. Three
  ways in, all ending in the same crop: the live camera in a viewfinder up to
  640px on a hairline edge, "Use the camera app" on a touch device, and
  "Choose a file". "Take photo" is the block, off until the camera is up.
- The **capture guide** is the item's own frame from the ratio table in
  section 5, drawn over the live picture, centred, at 86% of the largest
  frame that fits; what is inside is what is kept. It is a 2px `--gg-paper`
  line with a 1px `--gg-ink` outline at 60%, the one place a line is heavier
  than a hairline, because a hairline vanishes on a moving picture. A
  viewfinder rests on `--secondary` until the camera is up, as an image
  waits on its silhouette. Under it: "Plain
  background, straight on, fill the frame." The picture is cropped, resized
  to 1600px and re-encoded in the browser, and a 13px line says no location
  data is kept. It is shown once, with "Take it again" and the block "Save
  photo".
- **Photos** on the item page are each a `ProductImage` 160px tall, in the
  item's ratio with the edge finish, never cropped again on screen. The first
  says "On the website" in `Hint`; the others offer "Show first"; each has
  "Remove" in `text-destructive`. Empty: "No photos yet. The website shows the
  catalogue picture until there is one."
- The **Website switch** is a hairline row on the item page under VAT:
  "Website" in `MicroLabel`, the state in words ("Shown online", "Not
  online") and a `Switch`. One 13px grey line under it says whether the
  website shows the item right now, from the public feed itself, and if not
  why. Stock's ticked rows get "Show online" and "Take offline".
- **Settings, Website** is below the Save and acts at once: `Switch` rows
  that say their state ("Stock shows on the website", "Hidden"), a minimum
  price, the branches where new stock starts online ("Starts online") as
  hairline rows with "Remove", and "On the website now", six rows from the feed with a 40px
  image, title, condition and price.
- The **camera scanner** is one bottom sheet wherever it is used: "Hold the
  barcode or QR code steady in view.", a 4:3 viewfinder on a hairline edge,
  "Looking for a code" in `Hint` and, if the camera has one, "Torch on" as a
  `text` action. Which decoder reads is never shown: a browser whose
  `BarcodeDetector` reads QR codes uses it, Safari and tablets without one
  use `zxing-wasm`, loaded on first use from the app's own origin. With no
  camera or no permission the sheet is one sentence.

### Reports dashboard, Excel and VAT

- The **dashboard** is the first thing under Reports, below the page title
  and lede: the shared range control, a sentence ("... against 1 to 31 Aug")
  and a "Compare" `Switch`, on. Managers and admins only; anybody else is
  told so and left with the reports below.
- **Headline figures** are nine in a `dl`, two columns on a phone and three
  from 900px, each a `MicroLabel` over the figure. Net sales is the one KPI in
  Anton (28px, `tnum`); the rest are Jost 500 20px. Under each, in 13px grey,
  the change against the period before: "+£120.00", "-£15.00", "No change",
  "+1.2 points" for margin. The sign carries it, never a red or a green.
- The **day chart**, "Sales and profit", is a line chart 260px tall in the
  chart tokens: net sales in ink, cost in `--chart-3` and profit the one volt
  series, 1.5px lines, no dots, hairline axis, `--chart-4` gridlines,
  Space Mono ticks, a legend, a GBP tooltip and a hidden sentence for a
  screen reader. Under it are hairline `Table`s (By category, each branch a
  link into the Sales report; Top items; How it was paid) and Buy-ins and
  stock as five figures in the same `dl`. Below 900px a table is lines.
- The **VAT return** (`/counter/reports/vat`, listed under "VAT") opens with a
  "Quarter" `Select` and, when the server has one, a 15px ink note. The
  **nine boxes** are one hairline `Table`, not a form: box number, what it is
  in plain words, the amount right-aligned in `tnum`, in HMRC's order; box 5
  reads "Net VAT to pay HMRC" or "Net VAT to reclaim from HMRC". Under it, in
  13px grey: "GG Vault does not file the return. Copy boxes 1 to 9 into the
  Making Tax Digital software the shop uses (bridging software, or your
  accountant's) and submit it there by the deadline, then keep this Excel
  file with the VAT records."
- A registered shop's return adds four sections. **Purchases**: boxes 4 and
  7 are typed in, not worked out, so admins get two money fields and "Save
  purchases"; everybody else gets one sentence. **By rate**. **Margin
  scheme**: Sales, What they cost, Margin and "VAT at 1/6" as four figures in
  the `dl`, with a 13px sentence on how they are worked out. **Sales behind
  it**: chips over every sale and refund line, the first 200 with the count
  said.
- **Excel** sits beside CSV. The dashboard and the VAT return end on "Export
  Excel" as their one block (`--surface-3` until the figures are in) with
  "Export CSV" as a `text` action. A report keeps CSV as its block and adds
  "Export Excel" as a `text` action beside it. The file is built in the
  browser: a cover, a sheet per table, money as £#,##0.00 cells.
- **VAT treatment** is a `Select` labelled "VAT": "Margin scheme", "Standard
  rate, 20%", "Reduced rate, 5%", "Zero rate, 0%" or "Exempt". On Add stock
  it is a form field the chosen branch fills; on the item page it is a row,
  "VAT" in `MicroLabel` and a 220px select that saves on change, "As its
  branch" when none is set. Settings, VAT sits in the page's form; "VAT on
  till products" below the Save saves each choice as it is made.

---

## 12. Verifying a change

```bash
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web build

pnpm --filter web dev                       # then, in another shell:
node apps/web/scripts/screenshots.mjs       # writes apps/web/scripts/shots/
IMPECCABLE_BROWSER=/path/to/chromium \
  .claude/skills/impeccable/scripts/bin/linux-x64/impeccable \
  detect --viewport 1440x1200 http://localhost:5173/
```

`apps/web/scripts/screenshots.mjs` captures the kit page and both rebuilt
screens in light and dark at 1440x1200 and 390x844, plus one image per kit
section. The output directory is git-ignored. Hold the two rebuilds against the
three reference PNGs every time: if a change makes a screen heavier, tighter or
louder than the reference, it is the change that is wrong.
