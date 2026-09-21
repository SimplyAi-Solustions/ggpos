# GG Vault

Inventory, trade-in, loyalty and customer system for GG Entertainment, a games shop in Bolsover, Chesterfield. SumUp takes payment; GG Vault is the record of truth for stock, trade-ins, customers and the GG Guild loyalty programme.

See `PRODUCT.md` for who uses it and why, `docs/PLAN.md` for the full build plan, and `DESIGN.md` for the design system.

## Structure

```
apps/web/            React PWA: the staff counter, customer portal and display screens
pb/                   PocketBase backend: hooks, migrations, seed data
packages/shared/      SKU, money, pricing and loyalty logic shared by the app and the backend
services/pricesync/   Nightly job that syncs card price data
deploy/               Deployment files and the VPS runbook
docs/                 Plan, privacy, retention, label and CSV documentation
```

## Quick start

Prerequisites: Node 22 or later (see `.nvmrc`), pnpm 10.33 or later. Running `corepack enable` picks up the pinned pnpm version from `package.json` automatically.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. In one terminal, start PocketBase. This downloads the pinned binary on first run, applies migrations, and serves on `127.0.0.1:8091`:

   ```bash
   pnpm pb
   ```

3. In a second terminal, start the web app:

   ```bash
   pnpm dev
   ```

4. First run only: PocketBase starts with no superuser account, so it prints a one-time setup link in the terminal. Open that link (or go to `http://127.0.0.1:8091/_/`) to create the first superuser. This is the login for PocketBase's own admin UI, separate from the `staff` accounts used inside the app.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) - the approved build plan: architecture, data model, screens, phasing.
- [`DESIGN.md`](DESIGN.md) - the design system, component rules and copy rules.
- [`PRODUCT.md`](PRODUCT.md) - who the product is for, the jobs it does, and its constraints.
- [`deploy/README.md`](deploy/README.md) - the VPS deployment runbook.
