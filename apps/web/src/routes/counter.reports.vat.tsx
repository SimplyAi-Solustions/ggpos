import { createFileRoute } from "@tanstack/react-router"

import { VatReturnScreen } from "@/features/reports/VatReturnScreen"

/** The VAT return (docs/api-contract-launch.md, section 3), beside the nine reports. */
export const Route = createFileRoute("/counter/reports/vat")({
  component: VatReturnScreen,
})
