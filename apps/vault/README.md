# GG Vault (apps/vault)

The rebuilt staff app for GG Entertainment: scan or search cards, see
per-condition UK prices, build buy-in deals (cash or trade credit) and manage
stock. Phone first, used one-handed at the counter. No till, bookings or
loyalty; those stay in `apps/web` until they are retired.

Same stack as `apps/web`: Vite, React 19, TypeScript, TanStack Router (file
routes) and Query, Tailwind v4, the PocketBase JS client, lucide-react and
motion. Money goes through `@gg/shared/money` (integer pence in, `£1,234.56`
out).

```sh
pnpm --filter vault dev         # Vite on :5173, proxies /api to PocketBase on :8091 (pnpm pb)
pnpm --filter vault lint
pnpm --filter vault typecheck
pnpm --filter vault test
pnpm --filter vault build       # static files in apps/vault/dist
pnpm --filter vault publish:pb  # copies the build(s) into pb/pb_public
```

## Structure

```
src/
  main.tsx            providers (Query, Toast) and the router
  index.css           Tailwind, fonts, the Tailwind theme over the tokens
  styles/tokens.css   brand tokens, light and dark
  brand/              GG logo paths (from apps/web) and Logo, GMark, Wordmark
  lib/                pb client, staff auth, theme, query client, small hooks
  ui/                 the kit, imported from "@/ui"
  shell/              AppShell (header, tab bar, rail), nav, ThemeToggle, FeaturePlaceholder
  features/<name>/    one folder per feature: its screens, hooks and tests
  routes/             thin TanStack file routes that import from features
public/
  theme-init.js       sets the theme class before first paint (CSP allows no inline script)
  sw.js               retires the old app's service worker, see below
scripts/
  publish-pb.mjs      builds into pb/pb_public
```

Routes: `/login` is public. Everything else sits under the pathless `_app`
layout, which sends a signed-out visitor to `/login?redirect=...` and wraps
the page in the shell. `/` goes to `/scan`, and so does a sign-in with no
redirect.

| Path | Feature folder |
| --- | --- |
| `/scan` | `features/scan` |
| `/cards`, `/cards/$id` | `features/cards` |
| `/deals`, `/deals/new`, `/deals/$id` | `features/deals` |
| `/stock`, `/stock/new`, `/stock/$id` | `features/stock` |
| `/settings` | `features/settings` |
| `/more` | `features/more` (Settings link, theme, sign out) |
| `/login` | `features/auth` |

## Auth

The same approach as `apps/web/src/lib/auth.ts`: `pb.collection("staff")
.authWithPassword`, the SDK keeps the token in localStorage, and
`lib/auth.ts` turns it into a `Staff` snapshot (`useStaff()`,
`currentStaff()`). Only a `staff` record counts: the customer pages share the
auth store on the same origin, and a deactivated account's token is cleared.

## Tokens

All in `src/styles/tokens.css`, exposed to Tailwind in `src/index.css`. Use
the semantic names, never hex values, in components.

| Tailwind | Token | Light | Dark |
| --- | --- | --- | --- |
| `bg-bg`, `bg-bg-2` | `--bg`, `--bg-2` | `#f3f3ef`, `#e8e8e2` | `#040406`, `#0a0a0f` |
| `bg-panel`, `bg-panel-2` | `--panel`, `--panel-2` | `#ffffff`, `#f8f8f5` | `rgba(16,16,22,.58)`, `rgba(24,24,32,.66)` |
| `border-line`, `border-line-2` | `--line`, `--line-2` | ink 8%, 16% | white 8%, 14% |
| `text-fg`, `text-fg-2`, `text-fg-3` | `--fg`... | `#0b0b0b`, `#3d3d3a`, `#6e6e68` | `#f4f4f0`, `#b4b4ae`, `#8a8a84` |
| `bg-volt`, `bg-volt-deep` | `--volt` | `#fedf01`, `#e3c700` | same |
| `bg-pop`, `text-pop-text` | `--pop`, `--pop-text` | `#ff2e6b`, `#c4174c` | `#ff2e6b`, `#ff2e6b` |
| `text-ok`, `text-warn`, `text-info` | | darker partners | lime `#9cff6e`, orange `#ff9a3c`, cyan `#3ee6ff` |
| `text-accent-violet` | | `#6d4fd8` | `#a78bfa` |
| `text-ink`, `bg-paper` | brand constants | `#0b0b0b`, `#ffffff` | same |

Accessibility departures, on purpose: `--fg-3` is `#6e6e68` in light and
`#8a8a84` in dark rather than the brand's `#7a7a74` and the HQ's `#74746f`,
which fail AA as small text. `#7a7a74` stays as `--ink-3` for non-text marks.
Pop and the neons are not AA as text on paper, so light mode text uses the
darker partners (`--pop-text`, `--ok`, `--warn`, `--info`).

Using colour with intent:

- **Volt**: the primary action (`Button` primary), the active tab, "ready"
  states (`Card accent="volt"`, `Badge tone="volt"`), the focus ring. Text on
  volt is always ink (`text-on-volt`).
- **Pop**: highlights, the trade-credit side (`Segmented tone="pop"`,
  `PercentStepper tone="pop"`, `Money tone="pop"`), alerts and errors.
- Dark mode panels are glass: `.glass` applies `--panel` with a backdrop blur
  (`--panel-blur`, 0 in light). Volt and pop get a soft glow in dark only.

Type: Anton (`font-display`) for the one heading per screen, uppercase.
Poppins (`font-sans`) for body. Space Mono (`font-mono`) for numbers, labels
(`.label-mono`) and all money, with `.tnum`. Fonts are bundled with
@fontsource because the CSP is `font-src 'self'`.

Theme: light, dark or system, saved in localStorage under `gg-vault-theme`.
`public/theme-init.js` applies it before first paint; `lib/theme.ts`
(`useThemePreference`, `setPreference`) changes it and follows the system
while set to system.

Motion: `motion/react`. Sheets slide up and drag down to close, totals tween
(`<Money tween>`), cards tilt towards a mouse (`<Card tilt>`), the tab
indicator slides, pages fade between routes. All of it respects reduced
motion.

## UI kit (`@/ui`)

| Component | Key props |
| --- | --- |
| `Button` | `variant` primary, secondary, ghost, danger, pop; `size` sm, md, lg; `block`, `loading`, `icon`, `iconRight`. `buttonClasses()` styles a `Link` the same way |
| `IconButton` | `label` (required, the accessible name), `variant` ghost, secondary, primary; `size` |
| `Panel` | surface; `raised`, `flush` |
| `Card` | `tilt`, `accent` volt or pop |
| `Sheet` | `open`, `onClose`, `title`, `description`, `footer`. Bottom sheet on phones, centred from 768px |
| `Input` | `label`, `hint`, `error`, `leading`, `trailing`, `mono`, plus input props |
| `Field` | label, hint and error wiring for a custom control |
| `MoneyInput` | `value` (pence or null), `onChange(pence or null)`, `label`, `size` md or lg, `allowNegative` |
| `PercentStepper` | `value` (whole percent), `onChange`, `label`, `min`, `max`, `step` (default 5), `tone` volt or pop |
| `Segmented` | `options` [{ value, label, icon }], `value`, `onChange`, `label`, `tone` ink, volt, pop; `block` |
| `Chip` | `selected`, `icon`, button props |
| `Badge` | `tone` neutral, volt, pop, ok, warn, info, violet; `dot` |
| `Money` | `pence`, `tween`, `size` sm to xl, `tone` default, muted, volt, pop, ok |
| `EmptyState` | `icon`, `title`, children, `action` |
| `Skeleton` | `className`, `lines` |
| `ToastProvider`, `useToast` | `toast("Saved.")` or `toast({ message, tone: "ok" or "alert", duration })` |
| `PageHeader` | `eyebrow`, `title`, `actions`, children as the lede |

## Adding a feature screen

1. Build the screen in `src/features/<name>/`, export it from that folder's
   `index.ts`. Keep its API calls, hooks and tests in the same folder.
2. Add or edit the thin route file in `src/routes/` (for example
   `_app.deals.$id.tsx`). It only imports the screen and passes params or
   search in. Prefix with `_app.` so the auth guard and shell apply.
3. Run `pnpm --filter vault dev` (or `build`) once: the router plugin
   regenerates `src/routeTree.gen.ts`. Commit it.
4. Add a tab only in `src/shell/nav.ts`, which is shared, so agree it first.

The stub screens use `shell/FeaturePlaceholder`; replace that usage, do not
edit the placeholder itself.

## Deploying: how the vault replaces apps/web in pb_public

**Before**: the old app was built with `pnpm --filter web build` and copied
whole into `pb/pb_public` (`rm -rf pb/pb_public && cp -r apps/web/dist/.
pb/pb_public/`), in `deploy/self-update.sh`, `deploy/bootstrap.sh`,
`.github/workflows/deploy.yml` and `bootstrap-vps.yml`. PocketBase served
`index.html` for every unknown path (its SPA fallback).

**Now**: build both, then publish:

```sh
pnpm --filter web build      # still needed for the customer pages
pnpm --filter vault build
pnpm --filter vault publish:pb
```

`scripts/publish-pb.mjs` writes the vault build as `pb_public/index.html` and
the old app's page as `pb_public/account.html`, with both apps' hashed files
side by side in `assets/`. `pb/pb_hooks/appshell.pb.js` answers
`/account...`, `/c/...` and `/estimate` with `account.html`; every other path
falls through to PocketBase's fallback and gets the vault. Without an
`account.html` the hook does nothing, so the old single-app layout still
works.

The customer sign-up (`/account/sign-up`, `/account/verify`,
`/account/reset`), binders (`/account/binders`) and the rest of My Vault live
in apps/web, which is why it is still built.

What changes for the old app:

- Its staff screens (`/counter...`, `/display`, `/kit`, `/labels/print`,
  `/print/receipt/...`) are no longer reachable by address; those paths get
  the vault. `/login` is the vault's. Add a path to the hook's list to bring
  one back.
- Its service worker is not published. That worker answers every navigation
  with the cached `index.html`, which is now the vault, so it would break
  `/account`. The vault ships `public/sw.js` in its place, which clears the
  old caches and unregisters itself on browsers that had the old worker. The
  cost: My Vault loses offline caching and web push until the customer app
  registers a worker scoped to `/account/`.

The deploy scripts and workflows above have **not** been switched yet, since
`deploy.yml` ships `main` to the live shop. To switch the test site, replace
its copy step with the three commands above.
