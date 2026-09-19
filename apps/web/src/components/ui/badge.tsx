import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 font-mono text-[11px] font-bold tracking-[0.16em] whitespace-nowrap uppercase [&>svg]:size-3 [&>svg]:shrink-0 [&>svg]:stroke-[1.5]",
  {
    variants: {
      variant: {
        /** Points and tier. Ink on volt, never paper on volt. */
        volt: "bg-volt text-gg-ink",
        /** Everything else: a hairline pill. */
        outline: "border border-hairline text-foreground",
      },
    },
    defaultVariants: { variant: "outline" },
  }
)

function Badge({
  className,
  variant = "outline",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(badgeVariants({ variant }), className) },
      props
    ),
    render,
    state: { slot: "badge", variant },
  })
}

export { Badge, badgeVariants }
