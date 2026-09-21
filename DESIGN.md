# GG Vault design system

The staff and customer web app for GG Entertainment, Bolsover. This file records
the system as built in `apps/web`, not as planned: every token, component and
rule below exists in code and is shown on the kit page.

- Kit page: run `pnpm --filter web dev` and open `/`. Each rebuilt reference
  screen also renders on its own at `/?screen=atlas` and `/?screen=nova`.
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

Five places, and nowhere else: the G mark, the focused field's underline and
the active nav underline, points and tier badges, the done seal, and the focus
ring. Volt is never a background for text unless the text is ink. White on
yellow never appears.

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
  Its bar has five slots, Card, Quotes, Wants, Credit and Me: below 900px it
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
| `Chip`, `ChipGroup` | Condition, finish, rarity, filters. Hairline pill, Jost 500 13px, ink fill with paper text when pressed, 32px tall and 48px below 640px (the pill grows rather than taking an invisible hit area, because chips wrap and an overlay would send a tap to the wrong row). `ChipGroup` is a Base UI toggle group: arrow keys move, `multiple` allows several. Never yellow. |
| `MicroLabel`, `SectionHeading`, `Hint` | The three micro-text tones: label (`#3d3d3a`), section heading (ink, 32px above), helper (`#73736d`). |
| `PageTitle`, `Lede` | The one Anton line and its single grey sentence, 56ch maximum. |
| `Field`, `FieldRow`, `FieldError` | The only form layout. Owns label, hint, optional icon column, control and error. `FieldError` takes a react-hook-form message and renders one line under the control. |
| `Table` and parts | Hairline rows at ink 12%, Space Mono column headings, no zebra, no outer border, hover to `#f3f3ef`. `numeric` on a head or cell right-aligns it with `tnum`. `TableImageCell` is the 40px product image in the first column. `TableBody settle` with `TableRowSettle` rows adds the list entrance, for a body whose rows arrive together. |
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
| `CardPaymentSheet` (in `features/sell/`) | Waiting for the Solo reader: the amount in Anton at 28px, one sentence beside the thin ring about where the payment has got to, and Cancel. While an amount is live on the reader that is the only way out: no corner cross, and Esc and the backdrop are refused, because a sheet dismissed by accident would leave a customer paying with nothing watching. A decline says why in the reader's own words and offers Try again, except where trying again cannot work (a reader busy with somebody else's payment), which offers only Close. Money taken on a sale that then refuses is the state that is never lost: it names something to find the payment by (the receipt code, or the transaction id, or the card and the time) and the two ways out, and closing it leaves the same facts under the card amount on Sell, with a two-step "Refunded in the SumUp app" as the only way to put them down. |
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
- `useCountUp(value, { decimals })`: a KPI figure counts up once, over 600ms.
  Home's four tiles use it: the figure counts from nothing to the day's total
  when the numbers land, and says "Not counted yet" until they do rather than
  counting up to a zero that would read as a quiet day.
- `useScanPulse()`: the line a scan has just put in the basket flashes a
  1.5px volt bar along its underline. The bar grows from the left with
  `underlineGrow` and is taken away the same way, 150ms each; the second it
  holds in between is state, not motion, so nothing breaks the 200ms budget.
- `PageMain` (in `app/page-transition.tsx`) is `<main>` with the page
  entrance on it, keyed by the matched route's id, so a screen fades and
  rises once on arrival and not again when its own state changes. Both shells
  use it; no element is added between the content column and the screen.
- `TableBody settle` plus `TableRowSettle` give a list the row settle: 6px up,
  20ms apart. Put them on a body whose rows arrive together (Customers,
  Trade); leave them off one that grows a page at a time, or the rows already
  on screen settle again under the new ones.
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
  the sign. A whole number carries no decimal (`10%`) and anything finer
  carries exactly one place (`32.6%`), so a column of them lines up. Give the
  string the `tnum` class wherever it is a figure rather than a word in a
  sentence. Never `10 %`, never `10 per cent`, never a raw `0.1`.
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

## 10. Verifying a change

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
