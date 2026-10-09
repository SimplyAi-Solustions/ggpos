/**
 * The item page's photos (docs/api-contract-launch.md, section 6): every
 * photo of the item in order, the first marked as the one the website
 * shows, with Take photo, Show first and Remove.
 *
 * Each photo sits in the item's own frame on the canvas with the edge
 * finish, as a photograph does everywhere else in the app (DESIGN.md,
 * section 5), never cropped again on screen.
 */
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { ProductImage } from "@/components/product-image"
import { PhotoSheet } from "@/features/photos/PhotoSheet"
import { itemPhotos, makePhotoFirst, ONLINE_FEED_KEY, removeItemPhoto } from "@/lib/api/online"
import { refusalOrFallback } from "@/lib/api/refusal"
import type { ItemDetail } from "@/lib/api/types"

export function PhotoStrip({ item, onChanged }: { item: ItemDetail; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const photos = itemPhotos(item)
  const names = photos.map((photo) => photo.name)

  function changed(message: string) {
    setNote(message)
    onChanged()
    void queryClient.invalidateQueries({ queryKey: ONLINE_FEED_KEY })
  }

  const first = useMutation({
    mutationFn: (name: string) => makePhotoFirst(item.id, name, names),
    onSuccess: () => changed("That photo is first now. The website shows it."),
  })
  const remove = useMutation({
    mutationFn: (name: string) => removeItemPhoto(item.id, name),
    onSuccess: () => changed("Photo removed"),
  })
  const failure = first.error ?? remove.error
  const subject = React.useMemo(
    () => ({ id: item.id, sku: item.sku, kind: item.kind, retro_title: item.retro_title }),
    [item.id, item.sku, item.kind, item.retro_title]
  )

  return (
    <section className="mt-16" aria-label="Photos" data-testid="item-photos">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <MicroLabel tone="ink">Photos</MicroLabel>
        <Button variant="text" onClick={() => setOpen(true)}>
          Take photo
        </Button>
      </div>

      {photos.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
          No photos yet. The website shows the catalogue picture until there is one.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-8 gap-y-8">
          {photos.map((photo, at) => (
            <li key={photo.name} className="flex flex-col items-start gap-3" data-testid="item-photo">
              <ProductImage src={photo.thumb} alt={`Photo ${at + 1} of ${item.title || "the item"}`} platform={item.platform} finish="edge" height={160} />
              {at === 0 ? (
                <Hint>On the website</Hint>
              ) : (
                <Button variant="text" loading={first.isPending && first.variables === photo.name} onClick={() => first.mutate(photo.name)}>
                  Show first
                </Button>
              )}
              <Button
                variant="text-destructive"
                loading={remove.isPending && remove.variables === photo.name}
                onClick={() => remove.mutate(photo.name)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {failure || note ? (
        <p
          aria-live="polite"
          className={failure ? "mt-6 text-[13px] text-destructive" : "mt-6 text-[13px] text-muted-foreground"}
        >
          {failure ? refusalOrFallback(failure, "That did not save. Check the connection and try again.") : note}
        </p>
      ) : null}

      <PhotoSheet
        open={open}
        onOpenChange={setOpen}
        item={subject}
        onSaved={(saved) => changed(saved.length === 1 ? "Photo saved. The website shows it." : "Photo saved")}
      />
    </section>
  )
}
