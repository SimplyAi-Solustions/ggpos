# Retention schedule

How long GG Vault keeps each category of personal data, and why. This supports the privacy notice (`docs/privacy-notice.md`) and the DPIA (`docs/dpia.md`); figures come from `docs/PLAN.md`.

| Data category | Retention period | Reason | What happens at the end |
|---|---|---|---|
| ID photo | 12 months by default after the last cash buy-in (staff can set 6, 12 or 24 months) | Crime-prevention legitimate interest under the Data (Use and Access) Act 2025; a sensitive image should not be held longer than needed | Deleted automatically by the purge job. The ID fields (type, expiry, last four digits) stay on the customer's private record. |
| ID fields, seller snapshot, and trade-in and sale records | 6 years | HMRC record-keeping requirement; local dealer purchase-record rules where they apply | Kept as part of the numbered trade-in or sale record. These survive even if the customer later asks us to erase their profile; see Erasure below. |
| Quote photos | 90 days after the quote closes (`completed`, `declined` or `expired`) | No longer needed once a quote has an outcome | Deleted by the nightly `quote_photos_retention` cron (`pb_hooks/quotes.pb.js`), which reads `quotes.closed_at` - stamped the moment a quote first reaches one of those three statuses, whichever route or cron got it there, so a later reply or accept/decline on an already-closed quote never pushes the clock back the way reading `updated` instead would have. |
| Audit log | 6 years | Accountability for price overrides, refunds, ID photo views, personal data exports, deletions and loyalty rule changes | Deleted or archived once the period has passed. |
| Points and credit ledgers | For as long as the customer record exists | Needed to show the correct balance and history | Removed or anonymised when the customer record is erased. |
| Points balances themselves | Expire after 18 months with no points coming in (`loyalty_programme.expiry_months_inactive`; 0 turns expiry off) | The programme's own terms; a balance nobody has touched for a year and a half is not a liability the shop carries indefinitely | The nightly `points_expire` cron (`pb_hooks/loyalty.pb.js`) writes one `expire` row for the whole balance and tells the customer. Thirty days before, once, it sends a warning naming the figure and the date; any purchase clears the warning and starts the clock again. The rows themselves stay as history. |
| Reward vouchers (`reward_redemptions`) | For as long as the customer record exists; an unused one stops being valid 90 days after it is claimed (`settings.rewards.voucher_days`) | Needed to honour a voucher at the counter and to explain a points history | The nightly `vouchers_expire` cron marks an unused voucher past its date `expired`; no points come back, and cancelling (admin, which does return the points) is the deliberate way to undo one. Open vouchers are voided when the customer record is erased. |
| Referral records (`referrals`) | For as long as both customer records exist | Needed to pay a referral bonus once and only once, and to explain both ledgers | The row holds two customer ids, a status and the date the bonus was earned, and no personal data of its own. A merge re-points it, unless both of its ends would become the same customer, in which case it is deleted rather than left as somebody referring themselves. An erasure leaves it in place, by which point the customer record it names has been anonymised. |
| Memberships and monthly perk use (`memberships`, `perk_usage`) | For as long as the customer record exists | A membership is a paid contract and has to be auditable; the monthly counter is what stops an allowance being spent twice | Left in place by an erasure, against the anonymised customer record. A merge adds the duplicate's monthly counts to the record being kept rather than dropping either. |
| Notifications | 12 months | Operational message history; no need to keep it longer | Deleted. |

## Erasure

A customer can ask for this themselves in My Vault ("Delete my account", `POST /api/vault/me/delete`) or ask a member of staff to do it for them (`POST /api/vault/customers/:id/erase`); both run the identical erasure (`pb_hooks/lib/customerops.js`), so which door someone comes through never changes what actually happens. Either way we:

- anonymise their `customers` and `customer_private` records, so name, contact details and staff notes are removed or replaced;
- delete their ID photo, if one is still held;
- void any open, unredeemed rewards, so a voucher cannot be presented afterwards;
- delete their want-list rows, notifications, push subscriptions and quotes (photos included);
- rotate their sign-in so no token issued before the erasure keeps working;
- keep their numbered trade-in and sale records, with the seller snapshot taken at the time, for the remainder of the 6-year period. UK GDPR gives us this exception, Article 17(3)(b), because we have a legal obligation to keep the record;
- keep their points and credit ledgers, referral rows, memberships and monthly perk counts, all of which now point at an anonymised customer record. None of them carries a name, a contact detail or an ID field of its own, and each is needed to explain a balance, a bonus or a paid membership that did happen.

Both routes refuse with a plain "you/this customer still has store credit" message while a balance remains, rather than silently writing it off; the credit has to be spent or paid out first. A trade-in or sale record can outlive the customer profile it came from. That is expected, not a fault.

## Self-service export

"Download my data" in My Vault (`GET /api/vault/me/export`) gives a customer a JSON copy of their own customer record, trade-ins with lines, sales they are linked to, both ledgers, quotes (without photos), want list and notifications, their GG Guild tier and rolling-window points, their reward vouchers, memberships and this year's monthly perk counts, and their referrals as direction, status and date only, plus their consent flag and ID status. A referral never names the other person, by id, code or name: that is somebody else's record, and a subject access request is not a way to read one. It never includes an ID number, expiry, date of birth, address or photo - those stay staff-only, on `customer_private` and `id_documents`, neither of which a customer route can read. Every export is logged in the audit log by customer id, never by what was in it.
