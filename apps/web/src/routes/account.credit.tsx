import { createFileRoute } from "@tanstack/react-router"

import { WalletScreen } from "@/features/portal/WalletScreen"

/**
 * The wallet took over from the old credit ledger screen: Epos Now owns
 * store credit now, so the ledger here went quiet. CreditScreen.tsx stays
 * in the tree unused in case the ledger history is wanted back.
 */
export const Route = createFileRoute("/account/credit")({
  component: WalletScreen,
})
