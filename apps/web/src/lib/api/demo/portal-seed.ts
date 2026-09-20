/**
 * The three constants the demo portal is identified by.
 *
 * Kept in a module of their own, away from the fixtures themselves, because
 * the `/account` guard needs the customer id to decide whether somebody is
 * signed in and the guard travels in the entry bundle. Importing the whole
 * demo shop for one string would put the fixtures there with it.
 */

/** The demo portal signs in as the counter's first demo customer. */
export const DEMO_PORTAL_CUSTOMER_ID = "cust_demo_1"

/** Printed on the sign-in screen in demo mode, and accepted only there. */
export const DEMO_PORTAL_EMAIL = "jasmine.okafor@example.co.uk"
export const DEMO_PORTAL_CODE = "48213976"
