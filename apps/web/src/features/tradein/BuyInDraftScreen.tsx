import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { BuyInWizard } from "@/features/tradein/BuyInWizard"
import { hydrate, type WizardCustomer } from "@/features/tradein/machine"
import {
  getCustomer,
  getTradeIn,
  getTradeInLines,
  type IdStatus,
} from "@/lib/api"

/**
 * A draft reopened from the recent list.
 *
 * The wizard takes its whole starting state as a prop rather than filling
 * itself in from an effect, so there is never a frame where a half-loaded
 * buy-in is on screen and never a render that writes state back into itself.
 */
export function BuyInDraftScreen({ id }: { id: string }) {
  const navigate = useNavigate()

  const { data, isPending } = useQuery({
    queryKey: ["trade-in-draft", id],
    queryFn: async () => {
      const record = await getTradeIn(id)
      if (!record) return null
      const [lines, profile] = await Promise.all([
        getTradeInLines(id),
        record.customer ? getCustomer(record.customer) : Promise.resolve(null),
      ])
      const customer: WizardCustomer | null = profile
        ? {
            id: profile.customer.id,
            name: profile.customer.name,
            code: profile.customer.code,
            email: profile.customer.email ?? "",
            phone: profile.customer.phone ?? "",
            creditBalance: profile.private?.credit_balance ?? 0,
            facts: {
              flags: profile.private?.flags ?? [],
              idStatus: (profile.private?.id_status ?? "none") as IdStatus,
              idType: profile.private?.id_type,
              idExpiry: profile.private?.id_expiry,
              dob: profile.private?.dob,
              address: profile.private?.address,
            },
          }
        : null
      return { record, state: hydrate(record, lines, customer) }
    },
    // A draft is re-read from the server every time it is opened, never from
    // a stale cache: somebody else may have finished it at the other till.
    staleTime: 0,
  })

  if (isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <SkeletonText lines={6} />
      </section>
    )
  }

  if (!data) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>No such buy-in</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          That buy-in is not on file. It may have been cancelled.
        </p>
        <div className="mt-10">
          <Button
            type="button"
            trailingArrow
            onClick={() => void navigate({ to: "/counter/trade" })}
          >
            Back to trade
          </Button>
        </div>
      </section>
    )
  }

  if (data.record.status === "completed") {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Already bought in</PageTitle>
        <p className="tnum mt-4 font-mono text-[20px] leading-none text-foreground">
          {data.record.number}
        </p>
        <p className="mt-5 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          This buy-in is finished, so it cannot be edited. Open the receipt to
          reprint it.
        </p>
        <div className="mt-10">
          <Button
            type="button"
            trailingArrow
            onClick={() =>
              void navigate({ to: "/counter/trade/$id/receipt", params: { id } })
            }
          >
            Open the receipt
          </Button>
        </div>
      </section>
    )
  }

  return <BuyInWizard initial={data.state} />
}
