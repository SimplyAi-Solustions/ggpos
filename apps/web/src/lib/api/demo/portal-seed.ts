/**
 * The constants the demo portal is identified by.
 *
 * Kept in a module of their own, away from the fixtures themselves, because
 * the `/account` guard needs the customer id to decide whether somebody is
 * signed in and the guard travels in the entry bundle. Importing the whole
 * demo shop for one string would put the fixtures there with it.
 */

/** The demo portal's headline customer: the counter's first demo customer. */
export const DEMO_PORTAL_CUSTOMER_ID = "cust_demo_1"

/** Printed on the sign-in screen in demo mode, and accepted only there. */
export const DEMO_PORTAL_EMAIL = "jasmine.okafor@example.co.uk"
export const DEMO_PORTAL_CODE = "48213976"

/**
 * A second demo card, on a customer who holds no store credit.
 *
 * Erasure is refused while any credit remains, so without somebody in this
 * state the demo (and the end-to-end suite) can only ever reach the refusal
 * and never the path where the account is actually deleted. This is that
 * customer: the counter's own `T Bradbury`, who has an email and a zero
 * balance.
 */
export const DEMO_PORTAL_NO_CREDIT_ID = "cust_demo_4"
export const DEMO_PORTAL_NO_CREDIT_EMAIL = "tom.bradbury@example.co.uk"

/**
 * Which demo card is signed in.
 *
 * Lives here rather than in the fixtures so `features/portal/session.ts` can
 * restore it on a reload without dragging the whole demo shop into the entry
 * bundle. Only the demo path ever reads or writes it.
 */
let active: string = DEMO_PORTAL_CUSTOMER_ID

export function demoPortalCustomerId(): string {
  return active
}

export function setDemoPortalCustomer(id: string) {
  active = id || DEMO_PORTAL_CUSTOMER_ID
}

/** The demo card behind a typed email address, or null. */
export function demoPortalCustomerForEmail(email: string): string | null {
  const clean = email.trim().toLowerCase()
  if (!clean || clean === DEMO_PORTAL_EMAIL) return DEMO_PORTAL_CUSTOMER_ID
  if (clean === DEMO_PORTAL_NO_CREDIT_EMAIL) return DEMO_PORTAL_NO_CREDIT_ID
  return null
}
