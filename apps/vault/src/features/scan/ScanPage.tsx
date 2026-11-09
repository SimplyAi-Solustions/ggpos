import { ScanLine } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function ScanPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Counter"
      title="Scan"
      lede="Point the camera at a card or a barcode, or type a name."
      icon={<ScanLine aria-hidden />}
      plans={[
        "Camera scan of a card, matched to set and number",
        "Barcode scan for sealed and retro stock",
        "Per-condition UK prices on the result",
        "Add the result to a deal in one tap",
      ]}
    >
      <div className="relative mx-auto aspect-[63/88] w-full max-w-[260px] rounded-lg border border-line bg-panel-2">
        {["top-0 left-0 border-t-4 border-l-4 rounded-tl-lg", "top-0 right-0 border-t-4 border-r-4 rounded-tr-lg", "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-lg", "bottom-0 right-0 border-r-4 border-b-4 rounded-br-lg"].map((corner) => (
          <span key={corner} aria-hidden className={`absolute size-10 border-volt ${corner}`} />
        ))}
        <p className="label-mono absolute inset-x-0 bottom-4 text-center text-fg-3">Camera goes here</p>
      </div>
    </FeaturePlaceholder>
  )
}
