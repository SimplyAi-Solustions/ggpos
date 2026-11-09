/**
 * The customer offers flow (send cards for an offer: /estimate,
 * /account/estimate and /account/quotes/*) is parked behind one build-time
 * flag, off by default. Set VITE_CUSTOMER_OFFERS=1 at build time to bring it
 * back: the nav tab, the card screen link and the routes all key off this.
 * The staff side of quotes is untouched.
 */
export function offersEnabled(flag: string | undefined = import.meta.env.VITE_CUSTOMER_OFFERS as string | undefined): boolean {
  return flag === "1"
}
