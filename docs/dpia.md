# Data protection impact assessment

Scope: GG Vault, the inventory, trade-in, loyalty and customer system for GG Entertainment. This assessment follows the ICO's DPIA structure and covers the processing most likely to carry risk: ID photos taken at cash buy-ins, seller records kept for trade-ins and sales, loyalty profiling in GG Guild, and photos customers submit through the portal for a remote quote.

## Screening: why this assessment is needed

The processing involves ID documents, systematic recording of who sold what, and customer photographs that may show more than the item being valued. Together these meet the threshold for a DPIA.

## 1. Description of the processing

**ID photos.** Taken on a staff phone or the counter PC at the point of a cash buy-in, downscaled and stripped of EXIF location data, encrypted before storage, and viewable only through a logged route that requires a step-up check (password or MFA within the last 10 minutes). Purpose: to meet the shop's crime-prevention obligations and to have evidence on file if a dispute or a police enquiry arises.

**Seller records.** Name, address, ID type, ID expiry and the last four digits of the ID number, kept on the customer's private record; a snapshot of the same detail is taken on every cash trade-in so the register survives even if the customer record is later erased. Purpose: HMRC and local dealer record-keeping, and to answer a police enquiry about a specific transaction.

**Loyalty profiling.** GG Guild records purchases, points and tier per customer, and applies rule-based perks (discounts, bonus points, event access). This is simple, transparent, rule-based scoring, not machine learning, and it never blocks a purchase or changes a price at the till; it is assessed as **low risk**.

**Portal photos.** Customers upload up to 20 photos per quote from their own phone. Purpose: to value items before a visit. Photos may unintentionally show more than the item, for example a customer's home.

## 2. Necessity and proportionality

- ID capture is limited to cash buy-ins; card and credit-only transactions never ask for ID.
- The ID photo is downscaled and stripped of EXIF data before it is stored, and is kept for months, not indefinitely.
- Viewing an ID photo requires a step-up check and is written to the audit log; ordinary staff access to a customer record does not show the photo.
- Loyalty profiling uses only the customer's own purchase history, is disclosed in the programme terms, and a member of staff can explain any perk or tier to the customer on request.
- Portal photos are kept only until the quote closes, then deleted; customers are shown guidance on what to photograph, the item, not their surroundings.
- A less intrusive alternative, no ID check on cash buy-ins, was rejected: it would leave the shop unable to show it took reasonable steps to prevent handling stolen goods.

## 3. Risks

| Risk | Likelihood | Severity | Overall |
|---|---|---|---|
| An ID photo is viewed or exported by someone without a business reason | Low | High | Medium |
| ID photos are kept longer than the retention period | Low | Medium | Low |
| A seller record is disclosed to someone outside the shop without cause | Low | Medium | Low |
| Loyalty profiling produces an unfair or discriminatory outcome | Low | Low | Low |
| A portal photo shows more than the customer intended, for example their home or another person | Medium | Low | Low |
| A customer erasure request conflicts with the legal duty to keep a trade-in or sale record | Low | Low | Low |

## 4. Measures to reduce risk

- ID photos are encrypted before they are written to storage, with the key held outside `pb_data`.
- Viewing an ID photo requires the admin role, a step-up check, and writes an audit log entry before the image is streamed; the image is served with `Cache-Control: no-store` and never cached.
- A scheduled purge deletes ID photos once their retention period ends; the ID fields needed for the 6-year record stay on the customer's private record, separate from the photo.
- Customer-facing records (`customers`) and staff-only records (`customer_private`, `id_documents`, `notes`, `audit_log`) are separate PocketBase collections with separate API rules, so a customer can never read another customer's data, or the staff-only parts of their own.
- The loyalty engine is a documented, rule-based evaluator (`packages/shared`), not a black box; the admin editor shows the same calculation the server uses, and every points change is visible in the customer's ledger.
- The quote form tells customers what to photograph and asks them not to include other people; staff can decline or ask for a replacement photo before making an offer.
- Erasure anonymises the customer profile while keeping the numbered trade-in or sale record and its seller snapshot, so the legal record and the customer's personal profile are handled separately.

## 5. Sign-off

| Role | Name | Date |
|---|---|---|
| Assessment completed by | [placeholder] | [placeholder] |
| Reviewed by (data protection lead) | [placeholder] | [placeholder] |
| Outcome | [placeholder: proceed / proceed with mitigations] | |
| Next review | [placeholder, for example 12 months after go-live, or sooner on a material change] | |
