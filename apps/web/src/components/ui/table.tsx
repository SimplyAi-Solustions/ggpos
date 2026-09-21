import * as React from "react"
import { cn } from "cn"
import { motion } from "motion/react"

import { listContainer, listItem, useMotionVariants } from "@/design/motion"

/** No outer border, no zebra, no card. Hairline rows and a lot of air. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full border-collapse caption-bottom text-[15px]", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:border-hairline", className)}
      {...props}
    />
  )
}

/**
 * `settle` gives the rows the list entrance: 6px up and 20ms apart, the same
 * stagger every list in the app uses. Put it on a body whose rows arrive
 * together; leave it off one that grows a page at a time, or the rows already
 * on screen settle again under the new ones. `useMotionVariants` holds them
 * still for a reader who has asked for less motion.
 */
function TableBody({
  className,
  settle,
  ...props
}: React.ComponentProps<"tbody"> & { settle?: boolean }) {
  const variants = useMotionVariants(listContainer)
  if (!settle) {
    return <tbody data-slot="table-body" className={cn(className)} {...props} />
  }
  return (
    <motion.tbody
      data-slot="table-body"
      className={cn(className)}
      variants={variants}
      initial="hidden"
      animate="visible"
      {...(props as React.ComponentProps<typeof motion.tbody>)}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-hairline font-medium", className)}
      {...props}
    />
  )
}

const ROW_CLASS =
  "border-b border-hairline-soft transition-colors duration-150 ease-gg hover:bg-row-hover data-[state=selected]:bg-row-hover"

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn(ROW_CLASS, className)} {...props} />
}

/**
 * A row inside a `TableBody settle`: it takes its turn from the body, which is
 * why it sets `variants` but no `initial` or `animate`. The pairing is
 * required. On its own it inherits those labels from whatever motion ancestor
 * it finds, which is now `PageMain`, whose labels happen to be the same two
 * strings, so the rows would quietly animate on the page entrance instead of
 * as a list.
 */
function TableRowSettle({
  className,
  ...props
}: React.ComponentProps<typeof motion.tr>) {
  const variants = useMotionVariants(listItem)
  return (
    <motion.tr
      data-slot="table-row"
      className={cn(ROW_CLASS, className)}
      variants={variants}
      {...props}
    />
  )
}

type CellProps = { numeric?: boolean }

/** Space Mono micro-text, like every other label in the system. */
function TableHead({
  className,
  numeric,
  ...props
}: React.ComponentProps<"th"> & CellProps) {
  return (
    <th
      data-slot="table-head"
      data-numeric={numeric || undefined}
      className={cn(
        "px-3 py-3 align-middle font-mono text-[11px] font-bold tracking-[0.16em] whitespace-nowrap text-muted-foreground uppercase",
        numeric ? "text-right" : "text-left",
        "first:pl-0 last:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  numeric,
  ...props
}: React.ComponentProps<"td"> & CellProps) {
  return (
    <td
      data-slot="table-cell"
      data-numeric={numeric || undefined}
      className={cn(
        "px-3 py-3 align-middle text-foreground",
        numeric ? "tnum text-right" : "text-left",
        "first:pl-0 last:pr-0",
        className
      )}
      {...props}
    />
  )
}

/** The first column of a stock list: a 40px tall product image, nothing else. */
function TableImageCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-image-cell"
      className={cn("w-14 py-2 pr-3 pl-0 align-middle", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-left text-[13px] text-muted-foreground-2", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableRowSettle,
  TableCell,
  TableImageCell,
  TableCaption,
}
