/**
 * A catalogue tile (DESIGN.md, section 10, "Catalogue pane"): a 4px
 * hairline-soft outline on the canvas, the one place a till surface has an
 * edge, because a touch target needs one. The picture at 88px in its own
 * ratio and finish, then the name (two lines, then an ellipsis), then the
 * price. A till product with no picture shows its Lucide icon instead, never
 * a grey box; an open-price key says "Key price"; a stock line that is out
 * says so and cannot be pressed.
 */
import { formatGBP, type TillCatalogueItem, type TillCatalogueProduct } from "@gg/shared"
import type { LucideIcon } from "lucide-react"
import { cn } from "cn"

import { ProductImage } from "@/components/product-image"
import { Hint } from "@/components/ui/micro-label"
import { iconFor } from "@/features/till/icons"
import { platformForItem } from "@/lib/api/item-shape"
import type { ItemKind } from "@/lib/api/types"

export interface TileProps {
  title: string
  /** The price, "Key price", or an empty string for nothing. */
  price: string
  image?: string
  /** The `ProductImage` frame, for a picture that has one. */
  platform?: string
  Icon: LucideIcon
  disabled?: boolean
  /** Said under the name instead of the price, e.g. "Out of stock". */
  status?: string
  onPress: () => void
  testId?: string
}

export function Tile({
  title,
  price,
  image,
  platform,
  Icon,
  disabled = false,
  status,
  onPress,
  testId = "till-tile",
}: TileProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "group/tile flex min-h-[136px] w-full min-w-0 flex-col items-start gap-2 rounded-[var(--radius)] border border-hairline-soft bg-transparent p-3 text-left outline-none",
        "transition-colors duration-150 ease-gg",
        "hover:border-hairline active:bg-row-hover",
        "focus-visible:border-foreground",
        "disabled:cursor-not-allowed disabled:hover:border-hairline-soft"
      )}
    >
      <span className="flex h-[88px] w-full items-center justify-center" aria-hidden="true">
        {image ? (
          <ProductImage src={image} alt="" platform={platform} height={88} />
        ) : (
          <Icon
            className={cn(
              "size-7 stroke-[1.25]",
              disabled ? "text-muted-foreground-2" : "text-foreground"
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "line-clamp-2 w-full text-[15px] leading-[1.3] font-medium",
          disabled ? "text-muted-foreground-2" : "text-foreground"
        )}
      >
        {title}
      </span>
      {status ? (
        <Hint>{status}</Hint>
      ) : price ? (
        <span className="tnum mt-auto text-[15px] leading-none font-medium text-foreground">
          {price}
        </span>
      ) : null}
    </button>
  )
}

/** A key on a category: a till product or a stock line. */
export function KeyTile({
  product,
  item,
  label,
  onProduct,
  onItem,
}: {
  product?: TillCatalogueProduct
  item?: TillCatalogueItem
  label?: string
  onProduct: (product: TillCatalogueProduct) => void
  onItem: (item: TillCatalogueItem, label?: string) => void
}) {
  if (product) {
    const open = product.open_price || product.kind === "open_price"
    return (
      <Tile
        title={label || product.name}
        price={open ? "Key price" : formatGBP(product.price)}
        image={product.image_url || undefined}
        platform="other"
        Icon={iconFor({ product })}
        onPress={() => onProduct(product)}
      />
    )
  }
  if (item) return <ItemTile item={item} label={label} onItem={onItem} />
  return null
}

export function ItemTile({
  item,
  label,
  onItem,
}: {
  item: TillCatalogueItem
  label?: string
  onItem: (item: TillCatalogueItem, label?: string) => void
}) {
  const out = item.qty <= 0 || item.status !== "in_stock"
  return (
    <Tile
      title={label || item.title}
      price={formatGBP(item.price)}
      image={item.image_url || undefined}
      platform={platformForItem({ kind: item.kind as ItemKind })}
      Icon={iconFor({ item })}
      disabled={out}
      status={out ? "Out of stock" : undefined}
      onPress={() => onItem(item, label)}
    />
  )
}
