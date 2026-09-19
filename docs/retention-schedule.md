# Retention schedule

How long GG Vault keeps each category of personal data, and why. This supports the privacy notice (`docs/privacy-notice.md`) and the DPIA (`docs/dpia.md`); figures come from `docs/PLAN.md`.

| Data category | Retention period | Reason | What happens at the end |
|---|---|---|---|
| ID photo | 12 months by default after the last cash buy-in (staff can set 6, 12 or 24 months) | Crime-prevention legitimate interest under the Data (Use and Access) Act 2025; a sensitive image should not be held longer than needed | Deleted automatically by the purge job. The ID fields (type, expiry, last four digits) stay on the customer's private record. |
| ID fields, seller snapshot, and trade-in and sale records | 6 years | HMRC record-keeping requirement; local dealer purchase-record rules where they apply | Kept as part of the numbered trade-in or sale record. These survive even if the customer later asks us to erase their profile; see Erasure below. |
| Quote photos | 90 days after the quote closes | No longer needed once a quote has an outcome | Deleted. |
| Audit log | 6 years | Accountability for price overrides, refunds, ID photo views, personal data exports, deletions and loyalty rule changes | Deleted or archived once the period has passed. |
| Points and credit ledgers | For as long as the customer record exists | Needed to show the correct balance and history | Removed or anonymised when the customer record is erased. |
| Notifications | 12 months | Operational message history; no need to keep it longer | Deleted. |

## Erasure

When a customer asks us to delete their account, we:

- anonymise their `customers` and `customer_private` records, so name, contact details and staff notes are removed or replaced;
- delete their ID photo, if one is still held;
- void any open, unredeemed rewards;
- keep their numbered trade-in and sale records, with the seller snapshot taken at the time, for the remainder of the 6-year period. UK GDPR gives us this exception, Article 17(3)(b), because we have a legal obligation to keep the record.

A trade-in or sale record can outlive the customer profile it came from. That is expected, not a fault.
