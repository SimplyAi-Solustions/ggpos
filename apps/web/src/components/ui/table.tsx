import * as React from "react"
import { cn } from "cn"

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

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />
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

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-hairline-soft transition-colors duration-150 ease-gg",
        "hover:bg-row-hover data-[state=selected]:bg-row-hover",
        className
      )}
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
  TableCell,
  TableImageCell,
  TableCaption,
}
