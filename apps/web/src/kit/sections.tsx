import * as React from "react"
import {
  ArrowRightIcon,
  BoxIcon,
  CameraIcon,
  SearchIcon,
  TagIcon,
} from "lucide-react"
import { cn } from "cn"

import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldRow } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Seal } from "@/components/ui/seal"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { StickerCards, StickerOrbit, StickerRing } from "@/components/ui/sticker"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableImageCell,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { GMark, Wordmark } from "@/components/ui/wordmark"
import { ProductImage } from "@/components/product-image"
import { PLATFORM_KEYS, PLATFORMS } from "@/design/platforms"
import { useCountUp } from "@/design/motion"
import { boxArt, cardArt } from "@/kit/placeholder-art"

/* ------------------------------------------------------------------ layout */

export function KitSection({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24 pt-20">
      <SectionHeading id={`${id}-heading`} className="mt-0 mb-2">
        {title}
      </SectionHeading>
      {note ? (
        <p className="mb-8 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          {note}
        </p>
      ) : (
        <div className="mb-8" />
      )}
      {children}
    </section>
  )
}

function Specimen({
  label,
  note,
  children,
  className,
}: {
  label: string
  note?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3 border-t border-hairline-faint pt-5", className)}>
      <Hint>{label}</Hint>
      {note ? <p className="-mt-1 max-w-[64ch] text-[13px] text-muted-foreground">{note}</p> : null}
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ colour */

type Swatch = { token: string; light: string; dark: string; use: string }

const SWATCHES: Swatch[] = [
  { token: "--background", light: "#fbfbfa", dark: "#0b0b0b", use: "Canvas" },
  { token: "--foreground", light: "#0b0b0b", dark: "#fbfbfa", use: "Ink text" },
  { token: "--muted-foreground", light: "#3d3d3a", dark: "#c9c9c2", use: "Labels, ledes" },
  {
    token: "--muted-foreground-2",
    light: "#73736d",
    dark: "#8f8f88",
    use: "Placeholders, hints",
  },
  { token: "--primary", light: "#0b0b0b", dark: "#fbfbfa", use: "Block button" },
  { token: "--primary-hover", light: "#1f1f1d", dark: "#e8e8e2", use: "Block hover" },
  { token: "--secondary", light: "#f3f3ef", dark: "#1f1f1d", use: "Row hover" },
  { token: "--surface-3", light: "#e8e8e2", dark: "#262623", use: "Switch track off" },
  { token: "--accent", light: "#fedf01", dark: "#fedf01", use: "Volt: the one accent" },
  { token: "--volt-deep", light: "#e3c700", dark: "#e3c700", use: "Volt pressed" },
  { token: "--pop", light: "#ff2e6b", dark: "#ff2e6b", use: "Error underline" },
  { token: "--destructive", light: "#c4174c", dark: "#ff2e6b", use: "Error text" },
  { token: "--hairline", light: "ink 24%", dark: "paper 26%", use: "Input underline" },
  { token: "--hairline-soft", light: "ink 12%", dark: "paper 14%", use: "Table rows" },
  { token: "--hairline-faint", light: "ink 6%", dark: "paper 8%", use: "Dividers" },
  { token: "--ring", light: "#fedf01", dark: "#fedf01", use: "Focus ring" },
]

const CHARTS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"]

export function ColourSection() {
  return (
    <KitSection
      id="colour"
      title="Colour"
      note="Ink on an off-white canvas, three ink-tinted greys and one yellow. Volt appears in five places only: the mark, the focused underline and caret, the active nav underline, points and tier badges, and the done seal."
    >
      <ul className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
        {SWATCHES.map((swatch) => (
          <li key={swatch.token} className="flex flex-col gap-2.5">
            <span
              aria-hidden="true"
              className="h-14 w-full rounded-[var(--radius)] border border-hairline-soft"
              style={{ background: `var(${swatch.token})` }}
            />
            <span className="font-mono text-[11px] font-bold tracking-[0.08em] text-foreground">
              {swatch.token}
            </span>
            <span className="tnum font-mono text-[11px] text-muted-foreground-2">
              {swatch.light} &middot; {swatch.dark}
            </span>
            <span className="text-[13px] text-muted-foreground">{swatch.use}</span>
          </li>
        ))}
      </ul>

      <div className="mt-10 flex flex-col gap-3">
        <Hint>Chart series</Hint>
        <div className="flex h-12 w-full max-w-md overflow-hidden rounded-[var(--radius)] border border-hairline-soft">
          {CHARTS.map((token) => (
            <span key={token} className="flex-1" style={{ background: `var(${token})` }} />
          ))}
        </div>
      </div>
    </KitSection>
  )
}

/* -------------------------------------------------------------------- type */

export function TypeSection() {
  return (
    <KitSection
      id="type"
      title="Type"
      note="Anton for the one page title per screen, Space Mono for every tracked micro-label and code, Jost for body, inputs and table cells. Poppins does not appear in the app."
    >
      <div className="flex flex-col gap-8">
        <Specimen label="Page title" note="Anton 400, clamp 28 to 36px, .01em tracking.">
          <PageTitle>Add stock</PageTitle>
        </Specimen>

        <Specimen label="KPI figure" note="Anton 400, 28px, for offer totals and report numbers.">
          <p className="tnum font-display text-[28px] leading-[1.05] tracking-[0.01em] uppercase">
            &pound;1,240.00
          </p>
        </Specimen>

        <Specimen label="Micro-label" note="Space Mono 700, 11px, .16em: section headings, field labels, helper text, button labels.">
          <div className="flex flex-wrap items-center gap-8">
            <MicroLabel tone="ink">Scan item</MicroLabel>
            <MicroLabel>Assigned to</MicroLabel>
            <Hint>Press enter</Hint>
            <MicroLabel tone="alert">Required</MicroLabel>
          </div>
        </Specimen>

        <Specimen label="Code and time" note="Space Mono 400, 13px: SKUs, customer codes, set numbers, timestamps.">
          <p className="tnum font-mono text-[13px] text-muted-foreground">
            GG-0043-AB &middot; SV151-199 &middot; 19 Sep 2026, 14:32
          </p>
        </Specimen>

        <Specimen label="Scan field" note="Jost 300, 28px.">
          <p className="text-[28px] leading-[1.25] font-light text-muted-foreground-2">
            Scan barcode or type here
          </p>
        </Specimen>

        <Specimen label="Body" note="Jost 400, 16px, measured to 56 characters.">
          <Lede className="mt-0">
            Scan a barcode or enter an item code to continue. The counter screen keeps
            focus in the scan field, so a wedge scanner works without a click.
          </Lede>
        </Specimen>

        <Specimen label="Emphasis" note="Jost 500, 15px: chips and table cells.">
          <p className="text-[15px] font-medium">Charizard ex 199/165, near mint</p>
        </Specimen>

        <Specimen label="Tabular figures" note="The tnum utility, so money and counts line up in a column.">
          <div className="tnum flex flex-col text-[15px]">
            <span>&pound;1,240.00</span>
            <span>&pound;89.50</span>
            <span>&pound;7.00</span>
          </div>
        </Specimen>
      </div>
    </KitSection>
  )
}

/* ---------------------------------------------------------------- controls */

function KitDemo({
  label,
  note,
  className,
  children,
}: {
  label: string
  note?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-4 border-t border-hairline-faint pt-5", className)}>
      <Hint>{label}</Hint>
      {note ? <p className="-mt-2 max-w-[64ch] text-[13px] text-muted-foreground">{note}</p> : null}
      {children}
    </div>
  )
}

export function ControlsSection() {
  const [tracked, setTracked] = React.useState(true)
  const [condition, setCondition] = React.useState<string[]>(["nm"])
  const [finishes, setFinishes] = React.useState<string[]>(["holo"])
  const [note, setNote] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  return (
    <KitSection
      id="controls"
      title="Controls"
      note="Every control is a hairline, a fill or a piece of micro-text. No boxes, no fills behind inputs, no shadows on anything except a panel and the done seal."
    >
      <div className="flex flex-col gap-10">
        <KitDemo label="Input" note="Plain, with a leading icon, with a trailing hint, and invalid.">
          <div className="grid gap-8 md:grid-cols-2">
            <Input placeholder="Your name" aria-label="Your name" />
            <Input
              leadingIcon={<SearchIcon />}
              trailingHint="Press / to focus"
              placeholder="Search products, people, or anything"
              aria-label="Search"
            />
            <Input
              leadingIcon={<TagIcon />}
              trailingHint="Required"
              placeholder="e.g. 1062847"
              aria-label="Item ID"
            />
            <Input
              defaultValue="SV151-199"
              aria-invalid
              trailingHint="Not found"
              aria-label="Set number"
            />
          </div>
        </KitDemo>

        <KitDemo label="Scan input" note="Jost 300 at 28px: the biggest thing on a counter screen.">
          <Input
            size="scan"
            leadingIcon={<BarcodeGlyph />}
            trailingHint="Press enter"
            placeholder="Scan barcode or type here"
            aria-label="Scan barcode"
          />
        </KitDemo>

        <KitDemo label="Textarea" note="The same underline, growing as you type.">
          <Textarea
            placeholder="Add a note (optional)"
            maxLength={200}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            trailingHint={`${note.length} / 200`}
            aria-label="Note"
          />
        </KitDemo>

        <KitDemo label="Select" note="The same underline with a thin chevron.">
          <div className="grid gap-8 md:grid-cols-2">
            <Select>
              <SelectTrigger aria-label="Category">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">Card single</SelectItem>
                <SelectItem value="sealed">Sealed product</SelectItem>
                <SelectItem value="retro">Retro game</SelectItem>
              </SelectContent>
            </Select>
            <Select
              defaultValue="case-a"
              items={[
                { value: "case-a", label: "Case A" },
                { value: "back-room", label: "Back room" },
              ]}
            >
              <SelectTrigger aria-label="Location">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="case-a">Case A</SelectItem>
                <SelectItem value="back-room">Back room</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </KitDemo>

        <KitDemo label="Switch" note="Ink when on, paper thumb, never yellow.">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-4">
              <Switch
                checked={tracked}
                onCheckedChange={setTracked}
                aria-label="Keep this item in inventory"
              />
              <span className="text-[15px] text-muted-foreground">
                Keep this item in inventory
              </span>
            </div>
            <Switch size="sm" defaultChecked={false} aria-label="Small switch example" />
          </div>
        </KitDemo>

        <KitDemo label="Button" note="Block, circle, text, destructive text, ghost icon, and the loading state.">
          <div className="flex flex-wrap items-center gap-8">
            <Button trailingArrow>Save changes</Button>
            <Button variant="circle">Save item</Button>
            <Button variant="text">Clear all</Button>
            <Button variant="text-destructive">Delete item</Button>
            <Button variant="ghost-icon" aria-label="Use camera">
              <CameraIcon />
            </Button>
            <Button
              loading={loading}
              onClick={() => {
                setLoading(true)
                window.setTimeout(() => setLoading(false), 1600)
              }}
            >
              {loading ? "Saving" : "Press to load"}
            </Button>
          </div>
        </KitDemo>

        <KitDemo label="Chip group" note="Single select for condition, multi select for finish.">
          <div className="flex flex-col gap-5">
            <ChipGroup
              aria-label="Condition"
              value={condition}
              onValueChange={setCondition}
            >
              {["NM", "LP", "MP", "HP", "DMG"].map((grade) => (
                <Chip key={grade} value={grade.toLowerCase()}>
                  {grade}
                </Chip>
              ))}
            </ChipGroup>
            <ChipGroup
              aria-label="Finish"
              multiple
              value={finishes}
              onValueChange={setFinishes}
            >
              {["Holo", "Reverse", "Full art", "First edition"].map((finish) => (
                <Chip key={finish} value={finish.toLowerCase().replace(" ", "-")}>
                  {finish}
                </Chip>
              ))}
            </ChipGroup>
          </div>
        </KitDemo>

        <KitDemo label="Field" note="Label left from 900px, stacked below it, with an optional icon column.">
          <FieldRow className="max-w-[640px]">
            <Field label="Name" htmlFor="kit-name" hint="Required">
              <Input id="kit-name" placeholder="Charizard ex 199/165" />
            </Field>
            <Field
              label="Item ID"
              htmlFor="kit-item-id"
              icon={<TagIcon />}
              error="Card not found in Scarlet & Violet 151. Check the number or add it manually."
            >
              <Input id="kit-item-id" defaultValue="199/999" aria-invalid />
            </Field>
            <Field label="Notes" htmlFor="kit-notes" layout="stacked">
              <Input id="kit-notes" placeholder="Add a note (optional)" />
            </Field>
          </FieldRow>
        </KitDemo>

        <KitDemo label="Badge, Kbd, Avatar">
          <div className="flex flex-wrap items-center gap-8">
            <Badge variant="volt">1,240 pts</Badge>
            <Badge variant="volt">Gold tier</Badge>
            <Badge>Sealed</Badge>
            <Badge>Near mint</Badge>
            <KbdGroup>
              <Kbd>S</Kbd>
              <Kbd>B</Kbd>
              <Kbd>/</Kbd>
              <Kbd>Esc</Kbd>
            </KbdGroup>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>RG</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>JS</AvatarFallback>
              </Avatar>
              <Avatar size="sm">
                <AvatarFallback>AB</AvatarFallback>
              </Avatar>
            </AvatarGroup>
          </div>
        </KitDemo>

        <KitDemo label="Tabs, Tooltip, Separator">
          <div className="flex flex-col gap-8">
            <Tabs defaultValue="stock">
              <TabsList>
                <TabsTrigger value="stock">Stock</TabsTrigger>
                <TabsTrigger value="trade">Trade</TabsTrigger>
                <TabsTrigger value="customers">Customers</TabsTrigger>
              </TabsList>
              <TabsContent value="stock">
                <p className="text-[15px] text-muted-foreground">
                  Every individual item, what it is worth and where it is.
                </p>
              </TabsContent>
              <TabsContent value="trade">
                <p className="text-[15px] text-muted-foreground">
                  Buy-ins priced as a percentage of market value.
                </p>
              </TabsContent>
              <TabsContent value="customers">
                <p className="text-[15px] text-muted-foreground">
                  QR codes, store credit and the GG Guild.
                </p>
              </TabsContent>
            </Tabs>
            <div className="flex items-center gap-8">
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="text">Hover for a tooltip</Button>}
                />
                <TooltipContent>Press S to scan</TooltipContent>
              </Tooltip>
              <Separator orientation="vertical" className="h-6" />
              <Hint>Separator</Hint>
            </div>
          </div>
        </KitDemo>

        <KitDemo label="Sheet and Dialog" note="Paper panel, hairline edge, one soft shadow.">
          <div className="flex flex-wrap items-center gap-8">
            <Sheet>
              <SheetTrigger render={<Button variant="text">Open sheet</Button>} />
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Move item</SheetTitle>
                  <SheetDescription>
                    Choose where this item lives. The change is undoable for 8 seconds.
                  </SheetDescription>
                </SheetHeader>
                <SheetBody>
                  <Field label="Location" htmlFor="sheet-location" layout="stacked">
                    <Select>
                      <SelectTrigger id="sheet-location">
                        <SelectValue placeholder="Select a location" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="case-a">Case A</SelectItem>
                        <SelectItem value="back-room">Back room</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </SheetBody>
                <SheetFooter>
                  <Button trailingArrow>Move item</Button>
                  <Button variant="text">Cancel</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>

            <Dialog>
              <DialogTrigger render={<Button variant="text">Open dialog</Button>} />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete item</DialogTitle>
                  <DialogDescription>
                    This removes the item and its history. Sold items keep their record.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="text-destructive">Delete</Button>} />
                  <DialogClose render={<Button variant="text">Cancel</Button>} />
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </KitDemo>

        <KitDemo label="Skeleton" note="Hairline blocks, never a shimmer gradient.">
          <div className="flex max-w-md items-start gap-5">
            <Skeleton className="h-[56px] w-10" />
            <SkeletonText className="flex-1" lines={3} />
          </div>
        </KitDemo>
      </div>
    </KitSection>
  )
}

/* ---------------------------------------------------------------- data, brand */

const ROWS = [
  { sku: "GG-0043", name: "Charizard ex 199/165", set: "SV151", qty: 1, price: 289.0 },
  { sku: "GG-0044", name: "Pikachu VMAX 188/185", set: "SWSH4", qty: 2, price: 74.5 },
  { sku: "GG-0045", name: "Super Mario 64", set: "N64 PAL", qty: 1, price: 65.0 },
  { sku: "GG-0046", name: "Pokemon Red", set: "GB PAL", qty: 3, price: 42.0 },
]

export function DataSection() {
  const total = useCountUp(470.5, { decimals: 2 })

  return (
    <KitSection
      id="data"
      title="Data"
      note="Hairline rows, tracked column headings, no zebra, no outer border. Numbers sit right in tabular figures and the first column is a 40px product image."
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14" />
            <TableHead>Item</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Set</TableHead>
            <TableHead numeric>Qty</TableHead>
            <TableHead numeric>Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((row, index) => (
            <TableRow key={row.sku}>
              <TableImageCell>
                <ProductImage
                  height={40}
                  platform={index < 2 ? "tcg_card" : "gameboy_cart"}
                  src={
                    index < 2
                      ? cardArt(PLATFORMS.tcg_card.ratio)
                      : boxArt(PLATFORMS.gameboy_cart.ratio)
                  }
                  alt=""
                />
              </TableImageCell>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="tnum font-mono text-[13px] text-muted-foreground">
                {row.sku}
              </TableCell>
              <TableCell className="font-mono text-[13px] text-muted-foreground">
                {row.set}
              </TableCell>
              <TableCell numeric>{row.qty}</TableCell>
              <TableCell numeric>&pound;{row.price.toFixed(2)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-8 flex items-baseline gap-4">
        <MicroLabel>Offer total</MicroLabel>
        <span className="tnum font-display text-[28px] leading-none tracking-[0.01em]">
          &pound;{total}
        </span>
      </div>
    </KitSection>
  )
}

export function BrandSection() {
  return (
    <KitSection
      id="brand"
      title="Brand"
      note="The wordmark, the G traced from the logo, the done seal and the site's three doodles. Stickers appear in empty states, on the customer card and nowhere else."
    >
      <div className="flex flex-col gap-10">
        <KitDemo label="Wordmark and mark">
          <div className="flex flex-wrap items-center gap-10">
            <Wordmark />
            <Wordmark mark />
            <GMark className="h-8" />
            <span className="rounded-[var(--radius)] border border-hairline bg-gg-ink px-5 py-3">
              <GMark className="h-6" />
            </span>
          </div>
        </KitDemo>

        <KitDemo label="Done seal" note="Success screens only, once.">
          <div className="flex flex-wrap items-center gap-10">
            <Seal />
            <Seal tick />
          </div>
        </KitDemo>

        <KitDemo label="Stickers" note="Empty states and the customer card.">
          <div className="flex flex-wrap items-center gap-10">
            <StickerRing />
            <StickerOrbit />
            <StickerCards />
          </div>
        </KitDemo>

        <KitDemo label="Empty state">
          <div className="flex max-w-md flex-col items-start gap-5 py-6">
            <StickerCards className="size-14" />
            <div>
              <MicroLabel tone="ink">No stock yet</MicroLabel>
              <p className="mt-2 text-[15px] leading-[1.5] text-muted-foreground">
                Scan a barcode or add an item by hand. Everything you add shows up here
                with its price and location.
              </p>
            </div>
            <Button trailingArrow>Add stock</Button>
          </div>
        </KitDemo>
      </div>
    </KitSection>
  )
}

/* ---------------------------------------------------------- product images */

export function ProductImageSection() {
  return (
    <KitSection
      id="product-images"
      title="Product imagery"
      note="One frame per kind of thing, at the exact ratio, contained on the canvas and never cropped. Shadow for cut-outs with transparent corners, edge for printed box art."
    >
      <ul className="flex flex-wrap items-end gap-x-8 gap-y-10">
        {PLATFORM_KEYS.map((key) => {
          const spec = PLATFORMS[key]
          const src =
            spec.finish === "shadow" ? cardArt(spec.ratio) : boxArt(spec.ratio)
          return (
            <li key={key} className="flex w-[180px] flex-col gap-3">
              <ProductImage
                height={120}
                platform={key}
                src={src}
                alt={`${spec.label} placeholder`}
              />
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[11px] font-bold tracking-[0.08em] text-foreground">
                  {key}
                </span>
                <span className="tnum font-mono text-[11px] text-muted-foreground-2">
                  {spec.ratio[0]}:{spec.ratio[1]} &middot; {spec.finish}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="mt-14 grid gap-10 sm:grid-cols-2">
        <KitDemo label="Shadow finish" note="On a cut-out card with transparent corners.">
          <ProductImage
            height={220}
            platform="tcg_card"
            finish="shadow"
            src={cardArt(PLATFORMS.tcg_card.ratio)}
            alt="Card with the shadow finish"
          />
        </KitDemo>
        <KitDemo label="Edge finish" note="On printed box art.">
          <ProductImage
            height={220}
            platform="megadrive_box"
            finish="edge"
            src={boxArt(PLATFORMS.megadrive_box.ratio)}
            alt="Box art with the edge finish"
          />
        </KitDemo>
        <KitDemo label="Loading" note="The silhouette, at the shape the image will be.">
          <ProductImage height={220} platform="ps2_case" alt="" />
        </KitDemo>
        <KitDemo label="Both finishes" note="The same ratio, side by side.">
          <div className="flex items-end gap-8">
            <ProductImage
              height={220}
              ratio={[63, 88]}
              finish="shadow"
              src={cardArt([63, 88])}
              alt="Shadow finish"
            />
            <ProductImage
              height={220}
              ratio={[63, 88]}
              finish="edge"
              src={boxArt([63, 88])}
              alt="Edge finish"
            />
          </div>
        </KitDemo>
      </div>
    </KitSection>
  )
}

/* ------------------------------------------------------------------ motion */

export function MotionSection() {
  return (
    <KitSection
      id="motion"
      title="Motion"
      note="One easing, cubic-bezier(.16, 1, .3, 1). 150ms for a control you are touching, 200ms for something entering the page. No bounce, no elastic, and nothing at all when the reader asks for less motion."
    >
      <ul className="grid gap-x-10 gap-y-6 text-[15px] sm:grid-cols-2">
        {[
          ["Page fade-rise", "opacity 0 to 1, y 8px to 0, 200ms"],
          ["List stagger", "20ms between rows, y 6px"],
          ["Underline grow", "scaleX 0 to 1 from the left, 150ms"],
          ["Count up", "KPI figures once, 600ms"],
          ["Panel rise", "sheets and dialogs, y 12px, 200ms"],
          ["Seal in", "scale .94 to 1, no overshoot"],
        ].map(([name, detail]) => (
          <li key={name} className="flex flex-col gap-1 border-t border-hairline-faint pt-4">
            <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-foreground uppercase">
              {name}
            </span>
            <span className="text-[15px] text-muted-foreground">{detail}</span>
          </li>
        ))}
      </ul>
      <p className="mt-8 flex items-center gap-3 text-[15px] text-muted-foreground">
        <BoxIcon className="size-5 stroke-[1.25]" aria-hidden="true" />
        Focus any field above to see the underline grow.
        <ArrowRightIcon className="size-4 stroke-[1.25]" aria-hidden="true" />
      </p>
    </KitSection>
  )
}
