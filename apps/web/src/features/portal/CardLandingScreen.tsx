import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { GMark } from "@/components/ui/wordmark"
import { isDemo } from "@/lib/api/mode"
import { getCardLanding, getMe } from "@/lib/api/portal"
import { currentStaff } from "@/lib/auth"
import { findCustomerByScan } from "@/lib/api/customers"
import { useCustomerSession } from "@/features/portal/session"

/**
 * The QR landing on a Guild card, `/c/<token>`.
 *
 * Three people can scan this card, and they get three different answers:
 *
 * - a customer signed in to My Vault whose token it is, sent to their card;
 * - a staff member signed in at the counter, sent to that customer's profile,
 *   which is the one place the name is allowed to appear;
 * - anybody else, including the customer before they sign in, who sees the G
 *   mark and a sign-in link and never a name, a code or a balance.
 *
 * Nothing about the customer is fetched for the third case: the route answers
 * `{ known: true }` or 404 and no more.
 */
export function CardLandingScreen({ token }: { token: string }) {
  const navigate = useNavigate()
  const signedInCustomer = useCustomerSession()
  const staff = currentStaff()

  const landing = useQuery({
    queryKey: ["card-landing", token],
    queryFn: () => getCardLanding(token),
    enabled: !staff,
    retry: false,
  })

  const me = useQuery({
    queryKey: ["portal", "me"],
    queryFn: getMe,
    enabled: Boolean(signedInCustomer),
  })

  // A signed-in staff member goes to the counter's customer page: the lookup
  // takes the whole scanned link, exactly as the wedge listener sends it.
  const staffLookup = useQuery({
    queryKey: ["counter-card-landing", token],
    queryFn: () => findCustomerByScan(token),
    enabled: Boolean(staff),
    retry: false,
  })

  React.useEffect(() => {
    if (!staff) return
    const profile = staffLookup.data
    if (profile) {
      void navigate({
        to: "/counter/customers/$code",
        params: { code: profile.customer.code },
        replace: true,
      })
    }
  }, [staff, staffLookup.data, navigate])

  React.useEffect(() => {
    if (staff || !signedInCustomer) return
    if (me.data && me.data.customer.qr_token === token) {
      void navigate({ to: "/account", replace: true })
    }
  }, [staff, signedInCustomer, me.data, token, navigate])

  const known = landing.data?.known ?? !landing.isError

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-[560px] flex-col items-start justify-center px-5 py-16 sm:px-10">
      {staff && staffLookup.isPending ? (
        <SkeletonText lines={3} />
      ) : (
        <>
          <GMark className="h-10" title="GG Entertainment" />

          {known ? (
            <>
              <PageTitle className="mt-10">Guild card</PageTitle>
              <Lede>This card belongs to a GG Guild member.</Lede>
              <p className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                Sign in to My Vault to see the card it belongs to. If you found
                this card, hand it in at the shop in Bolsover.
              </p>
              <div className="mt-12">
                <Button render={<Link to="/account" />} trailingArrow>
                  Sign in to My Vault
                </Button>
              </div>
            </>
          ) : (
            <>
              <PageTitle className="mt-10">Card not found</PageTitle>
              <Lede>That link does not match a Guild card.</Lede>
              <p className="mt-6 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
                Check the link, or ask at the counter and we will print a new
                card.
              </p>
              <div className="mt-12">
                <Button render={<Link to="/account" />} trailingArrow>
                  Go to My Vault
                </Button>
              </div>
            </>
          )}

          {isDemo() ? <Hint className="mt-16 block">Demo data</Hint> : null}
        </>
      )}
    </main>
  )
}
