# Data protection impact assessment

Scope: GG Vault, the inventory, trade-in, loyalty and customer system for GG Entertainment. This assessment follows the ICO's DPIA structure and covers the processing most likely to carry risk: ID photos taken at cash buy-ins, seller records kept for trade-ins and sales, loyalty profiling in GG Guild, and photos customers submit through the portal for a remote quote.

## Screening: why this assessment is needed

The processing involves ID documents, systematic recording of who sold what, and customer photographs that may show more than the item being valued. Together these meet the threshold for a DPIA.

## 1. Description of the processing

**ID photos.** Taken on a staff phone or the counter PC at the point of a cash buy-in, downscaled and stripped of EXIF location data, encrypted before storage, and viewable only through a logged route that requires a step-up check (password or MFA within the last 10 minutes). Purpose: to meet the shop's crime-prevention obligations and to have evidence on file if a dispute or a police enquiry arises.

**Seller records.** Name, address, ID type, ID expiry and the last four digits of the ID number, kept on the customer's private record; a snapshot of the same detail is taken on every cash trade-in so the register survives even if the customer record is later erased. Purpose: HMRC and local dealer record-keeping, and to answer a police enquiry about a specific transaction.

**Loyalty profiling.** GG Guild records purchases, points and tier per customer, and applies rule-based perks (discounts, bonus points, event access). This is simple, transparent, rule-based scoring, not machine learning, and it never blocks a purchase or changes a price at the till; it is assessed as **low risk**.

**Portal photos.** Customers upload up to 20 photos per quote from their own phone. Purpose: to value items before a visit. Photos may unintentionally show more than the item, for example a customer's home.

**Online sign-up (added October 2026).** Anybody can create a My Vault account from the website or the portal with a name, an email address, a marketing choice and acceptance of the GG Guild terms. Nothing is collected beyond what the counter already takes, and no phone number, address or date of birth is asked for. The account only becomes usable, and the welcome points are only added, once the person signs in with the code emailed to that address, which shows they control it. The sign-up answers the same way whether or not the address is already on a card, so it cannot be used to find out who shops here.

**Sharing with Epos Now (added October 2026).** The shop's till is Epos Now. So that a customer's card scans at the till, GG Vault creates a matching Epos Now customer holding their first name and surname, their email address, their GG Vault card code as the card number, and their email marketing choice. This happens when a customer asks to join a paid Guild plan online, or when staff link them. Epos Now holds that copy on the shop's behalf as its till provider. GG Vault then reads back the till's sales of the Guild membership product to start the membership. Purpose: to take payment for a membership at the till and start it without anybody typing it in twice.

**Agent access (added October 2026).** A read-only watcher account (an "agent", used by the shop's own assistant to tell staff when something is waiting) can see new quotes and pending Guild sign-ups with the customer's first name only, a short excerpt of their quote message and a link for staff. It cannot read any customer record, ID data or staff screen.

## 2. Necessity and proportionality

- ID capture is limited to cash buy-ins; card and credit-only transactions never ask for ID.
- The ID photo is downscaled and stripped of EXIF data before it is stored, and is kept for months, not indefinitely.
- Viewing an ID photo requires a step-up check and is written to the audit log; ordinary staff access to a customer record does not show the photo.
- Loyalty profiling uses only the customer's own purchase history, is disclosed in the programme terms, and a member of staff can explain any perk or tier to the customer on request.
- Portal photos are kept only until the quote closes, then deleted; customers are shown guidance on what to photograph, the item, not their surroundings.
- Online sign-up asks for the same minimum the counter does (name and email) and nothing more. The emailed code confirms the address before any points are given, and the sign-up never reveals whether an address is already registered.
- Only four fields go to Epos Now: name, email address, card code and the email marketing choice. Phone number, address, date of birth, ID details, purchase history and points stay in GG Vault. Without the card code on the till, a member would have to be found by hand at every sale.
- The agent account sees a first name and a short message excerpt and nothing else; it is created by an admin and can be switched off.
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
| Somebody signs up with another person's email address | Medium | Low | Low |
| A customer's name and email stay in Epos Now after they are erased from GG Vault | Medium | Low | Low |
| The Epos Now webhook address leaks and is used to send fake sales | Low | Medium | Low |
| The agent account's password leaks | Low | Low | Low |

## 4. Measures to reduce risk

- ID photos are encrypted before they are written to storage, with the key held outside `pb_data`.
- Viewing an ID photo requires the admin role, a step-up check, and writes an audit log entry before the image is streamed; the image is served with `Cache-Control: no-store` and never cached.
- A scheduled purge deletes ID photos once their retention period ends; the ID fields needed for the 6-year record stay on the customer's private record, separate from the photo.
- Customer-facing records (`customers`) and staff-only records (`customer_private`, `id_documents`, `notes`, `audit_log`) are separate PocketBase collections with separate API rules, so a customer can never read another customer's data, or the staff-only parts of their own.
- The loyalty engine is a documented, rule-based evaluator (`packages/shared`), not a black box; the admin editor shows the same calculation the server uses, and every points change is visible in the customer's ledger.
- The quote form tells customers what to photograph and asks them not to include other people; staff can decline or ask for a replacement photo before making an offer.
- Erasure anonymises the customer profile while keeping the numbered trade-in or sale record and its seller snapshot, so the legal record and the customer's personal profile are handled separately.
- A sign-up with somebody else's email address cannot be used: the account only opens with the code sent to that address, earns no points until then, and the real owner can delete it from My Vault.
- GG Vault does not delete from Epos Now itself. When a customer linked to Epos Now is erased, the link is removed in GG Vault and every admin is told which Epos Now customer to delete in Epos Now Back Office. That step is in the runbook and should be done the same day.
- The webhook address contains a long secret, and GG Vault never trusts the sale a webhook describes: it reads the sale back from Epos Now with the shop's own API key before acting on it. The Epos Now API key and the webhook secret are stored server-side and never sent to a browser.
- The agent account has no access to any customer record, ID photo or staff route, and every rule that admits it is tested in `pb/scripts/check.sh`.
- Epos Now is a processor for the shop: check that the Epos Now terms the shop accepted include a data processing agreement, and note Epos Now in the record of processing.

## 5. Sign-off

| Role | Name | Date |
|---|---|---|
| Assessment completed by | [placeholder] | [placeholder] |
| Reviewed by (data protection lead) | [placeholder] | [placeholder] |
| Outcome | [placeholder: proceed / proceed with mitigations] | |
| Next review | [placeholder, for example 12 months after go-live, or sooner on a material change] | |
