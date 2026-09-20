# Retention schedule

How long GG Vault keeps each category of personal data, and why. This supports the privacy notice (`docs/privacy-notice.md`) and the DPIA (`docs/dpia.md`); figures come from `docs/PLAN.md`.

| Data category | Retention period | Reason | What happens at the end |
|---|---|---|---|
| ID photo | 12 months by default after the last cash buy-in (staff can set 6, 12 or 24 months) | Crime-prevention legitimate interest under the Data (Use and Access) Act 2025; a sensitive image should not be held longer than needed | Deleted automatically by the purge job. The ID fields (type, expiry, last four digits) stay on the customer's private record. |
| ID fields, seller snapshot, and trade-in and sale records | 6 years | HMRC record-keeping requirement; local dealer purchase-record rules where they apply | Kept as part of the numbered trade-in or sale record. These survive even if the customer later asks us to erase their profile; see Erasure below. |
| Quote photos | 90 days after the quote closes (`completed`, `declined` or `expired`) | No longer needed once a quote has an outcome | Deleted by the nightly `quote_photos_retention` cron (`pb_hooks/quotes.pb.js`), which reads `quotes.closed_at` - stamped the moment a quote first reaches one of those three statuses, whichever route or cron got it there, so a later reply or accept/decline on an already-closed quote never pushes the clock back the way reading `updated` instead would have. |
| Audit log | 6 years | Accountability for price overrides, refunds, ID photo views, personal data exports, deletions and loyalty rule changes | Deleted or archived once the period has passed. |
| Points and credit ledgers | For as long as the customer record exists | Needed to show the correct balance and history | Removed or anonymised when the customer record is erased. |
| Notifications | 12 months | Operational message history; no need to keep it longer | Deleted. |

## Erasure

A customer can ask for this themselves in My Vault ("Delete my account", `POST /api/vault/me/delete`) or ask a member of staff to do it for them (`POST /api/vault/customers/:id/erase`); both run the identical erasure (`pb_hooks/lib/customerops.js`), so which door someone comes through never changes what actually happens. Either way we:

- anonymise their `customers` and `customer_private` records, so name, contact details and staff notes are removed or replaced;
- delete their ID photo, if one is still held;
- void any open, unredeemed rewards;
- delete their want-list rows, notifications, push subscriptions and quotes (photos included);
- rotate their sign-in so no token issued before the erasure keeps working;
- keep their numbered trade-in and sale records, with the seller snapshot taken at the time, for the remainder of the 6-year period. UK GDPR gives us this exception, Article 17(3)(b), because we have a legal obligation to keep the record.

Both routes refuse with a plain "you/this customer still has store credit" message while a balance remains, rather than silently writing it off; the credit has to be spent or paid out first. A trade-in or sale record can outlive the customer profile it came from. That is expected, not a fault.

## Self-service export

"Download my data" in My Vault (`GET /api/vault/me/export`) gives a customer a JSON copy of their own customer record, trade-ins with lines, sales they are linked to, both ledgers, quotes (without photos), want list and notifications, plus their consent flag and ID status. It never includes an ID number, expiry, date of birth, address or photo - those stay staff-only, on `customer_private` and `id_documents`, neither of which a customer route can read. Every export is logged in the audit log by customer id, never by what was in it.
