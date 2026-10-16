# GG Guild: loyalty guide

An admin's guide to the loyalty engine as designed in `docs/PLAN.md`. GG Guild is rule-based, and every number in it can be changed from the admin screens without a code change. The same calculation runs in the admin editor's live preview and on the server (`packages/shared`), so the preview never disagrees with what a customer actually earns.

## Programme settings

One record, `loyalty_programme`, holds the whole programme:

- **Enabled**: turns the whole programme on or off.
- **Name and points name**: GG Guild, and whatever points are called, for example "Guild Points".
- **Earn per pound (sales)**: base points earned per £1 spent in a sale.
- **Earn on trade-in credit**: base points earned per £1 of store credit taken in a trade-in.
- **Points per pound (redemption)**: how many points a customer spends to redeem £1 of value.
- **Minimum redeem points**: the smallest number of points a customer must hold before they can redeem anything.
- **Maximum points share of a sale**: caps how much of one sale's total can be paid with points, so points cannot cover an entire large purchase.
- **Expiry (months inactive)**: how long a customer can go without activity before their points start expiring.
- **Tier window**: the rolling period, 12 months by default, that tier thresholds are measured against.
- **Welcome bonus**: points awarded when a customer joins.
- **Referral bonus**: points awarded to the referrer and to the referee.
- **Terms**: the programme terms text shown when a customer joins.

## Rule types, with worked examples

Rules in `loyalty_rules` run in priority order on top of the base points. Multipliers stack multiplicatively; fixed bonuses add. Each rule has conditions (game, item kind, minimum spend, weekdays, a date range) and only applies when the sale or trade-in matches them.

**Worked example: a weekend multiplier.** A customer buys a sealed Pokémon product for £30 on a Saturday. The programme's base rate is 10 points per £1, so the sale earns 300 points before any rules. A multiplier rule, "Weekend x2", applies on Saturdays and Sundays with a value of 2. Because the sale falls on a Saturday, the rule applies: 300 x 2 = **600 points**.

The rule types:

- **multiplier**: multiplies the points earned so far by a factor, for example the weekend x2 rule above.
- **fixed_bonus**: adds a flat number of points when the conditions match, for example 50 bonus points on any Yu-Gi-Oh! purchase during a launch weekend.
- **first_purchase**: a one-off bonus on a customer's first completed sale.
- **birthday_month**: a bonus that applies during the customer's birthday month.
- **trade_in_credit_bonus**: extra points per £1 of store credit taken in a trade-in, on top of the base trade-in earn rate. For example, if this rate is set to 5 points per £1, a customer taking £50 in credit earns 250 points from this rule alone.
- **event_checkin**: a bonus for checking in at a shop event.
- **day_of_week**: like the weekend multiplier, but for any set of weekdays, not only Saturday and Sunday.

## Tiers and perks

`loyalty_tiers` hold a name, a points threshold measured over the rolling tier window, and a list of perks. The default tiers are Member, Regular and Legend. A tier can also be a paid plan, a Guild Pass style membership that grants the tier regardless of points, tracked in `memberships`.

Perk types: percent off on chosen categories, a points multiplier, free event entries, lounge hours, priority release booking, and member event pricing. Perks with a monthly limit are tracked in `perk_usage` against the current month, so the count resets automatically; for example, a tier might grant two free event entries and twelve lounge hours a month.

## Rewards and redemption by QR

`loyalty_rewards` is the catalogue: name, description, points cost, type (money off, store credit, a free item, event entry, or something custom), stock and per-customer limits, and an active window. A customer redeems a reward in My Vault, which creates a `reward_redemptions` row and shows it as a QR code on their phone. At the till, staff scan that code; it carries the reward voucher's own kind letter (see `docs/label-spec.md` for the full code format) and applies the reward to the sale. A redemption's status moves from issued to used, expired or cancelled, and records which sale it was used in.

## Referrals

A customer shares their referral code. When the person they referred completes their first sale or trade-in, both the referrer and the referee earn the referral bonus. `referrals` tracks the pair as pending until that first transaction happens, then earned.

## Memberships

`memberships` records a paid, Guild Pass style plan: which tier it grants, whether it is active, lapsed or cancelled, when it started and renews, and what was paid. These are recorded by staff for now; billing through Stripe is a possible later addition, not part of v1.

## Expiry and warnings

Points expire after a customer has been inactive for the configured number of months. A notification warns the customer 30 days before their points expire, and the expiry itself is written to `points_ledger` with the reason `expire`.

## Refunds and points

Refunding a sale reverses everything that sale earned: the points from that line are removed from the customer's balance with a `refund_reverse` entry in `points_ledger`, and any perk-usage counter the sale incremented, a free event entry, for example, is given back. If the customer already spent the points before the refund, the reversal can take their balance negative; the `adjust` reason in `points_ledger` exists for a member of staff to correct a balance by hand when that happens.

## Default seed values

These ship as starting defaults for the owner to change in the admin editor; they are not fixed decisions:

- 10 points earned per £1 spent on sales.
- 100 points redeem for £1 of value.
- Tiers: Member at 0 points, Regular at 2,500, Legend at 10,000, measured over a rolling 12 months.
- Welcome bonus: 100 points.
- Referral bonus: 250 points to the referrer, 250 to the referee.

## Reporting

The Loyalty report, see `docs/PLAN.md` ("Reporting"), shows points issued and redeemed, tier distribution, perk usage, reward take-up, referral conversions, and programme cost as a percentage of revenue.
