import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Textarea } from "@/components/ui/textarea"
import { createQuote } from "@/lib/api/quotes"
import { refusalOrFallback } from "@/lib/api/refusal"
import { usePortalDock } from "@/features/portal/dock"
import { DROP_OFF_LABEL } from "@/features/portal/format"
import {
  MAX_PHOTOS,
  preparePhotos,
  roomLeft,
  type PreparedPhoto,
} from "@/features/portal/quote-photos"
import type { QuoteDropOff } from "@/lib/api/types"

const MAX_MESSAGE = 4000

/**
 * Get a quote: photos, a message, and how the items will reach us.
 *
 * Every photo is resized to 1600px on its long edge and re-encoded as JPEG
 * before it is added to the form, which is also what drops the EXIF the
 * camera wrote. Nothing leaves the phone until the block button is pressed,
 * and nothing that failed to open is silently dropped: each one comes back
 * with a sentence saying what to do.
 */
export function NewQuoteScreen() {
  const dock = usePortalDock()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileRef = React.useRef<HTMLInputElement>(null)

  const [photos, setPhotos] = React.useState<PreparedPhoto[]>([])
  const [rejected, setRejected] = React.useState<string[]>([])
  const [message, setMessage] = React.useState("")
  const [dropOff, setDropOff] = React.useState<QuoteDropOff>("in_store")
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = useMutation({
    mutationFn: () =>
      createQuote({ photos: photos.map((photo) => photo.blob), message, dropOff }),
    onSuccess: async (quote) => {
      await queryClient.invalidateQueries({ queryKey: ["portal"] })
      await navigate({ to: "/account/quotes/$id", params: { id: quote.id } })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(
          cause,
          "That did not send. Check your connection and try again."
        )
      ),
  })

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    setWorking(true)
    setError(null)
    try {
      const result = await preparePhotos(Array.from(list), photos.length)
      setPhotos((current) => [...current, ...result.photos])
      setRejected(result.rejected)
    } finally {
      setWorking(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const primary = (
    <Button
      type="button"
      trailingArrow
      loading={submit.isPending}
      disabled={photos.length === 0 || working}
      onClick={() => submit.mutate()}
    >
      Send for a quote
    </Button>
  )

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Get a quote</PageTitle>
      <Lede>Photograph what you want to sell. We will price it before you travel.</Lede>

      <SectionHeading className="mt-14">Photos</SectionHeading>
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
        Up to {MAX_PHOTOS} photos, one card or one box each where you can. We
        shrink them on your phone first, so nothing but the picture is sent.
      </p>

      <input
        ref={fileRef}
        data-testid="quote-photo-input"
        id="quote-photos"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        aria-label="Add photos of what you are selling"
        className="sr-only"
        onChange={(event) => void addFiles(event.target.files)}
      />

      <div className="mt-6 flex flex-wrap items-center gap-6">
        <Button
          type="button"
          variant="text"
          loading={working}
          disabled={roomLeft(photos.length) === 0}
          onClick={() => fileRef.current?.click()}
        >
          Add photos
        </Button>
        <Hint aria-live="polite">
          {`${photos.length} of ${MAX_PHOTOS} added`}
        </Hint>
      </div>

      {photos.length > 0 ? (
        <ul className="mt-8 grid grid-cols-3 gap-3 sm:grid-cols-4">
          {photos.map((photo, index) => (
            <li key={photo.id} className="relative">
              <img
                src={photo.preview}
                alt={`Photo ${index + 1}`}
                width={photo.width}
                height={photo.height}
                className="aspect-square w-full border border-hairline-soft bg-background object-cover"
              />
              <Button
                type="button"
                variant="ghost-icon"
                aria-label={`Remove photo ${index + 1}`}
                className="absolute top-1 right-1 bg-background/90"
                onClick={() =>
                  setPhotos((current) =>
                    current.filter((entry) => entry.id !== photo.id)
                  )
                }
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {rejected.length > 0 ? (
        <ul className="mt-6 flex flex-col gap-2" role="alert">
          {rejected.map((sentence) => (
            <li key={sentence} className="text-[13px] leading-[1.45] text-destructive">
              {sentence}
            </li>
          ))}
        </ul>
      ) : null}

      <SectionHeading className="mt-14">Anything to tell us</SectionHeading>
      <Field layout="stacked" label="Message" htmlFor="quote-message">
        <Textarea
          id="quote-message"
          value={message}
          maxLength={MAX_MESSAGE}
          rows={3}
          placeholder="Conditions, how many, anything we should know"
          trailingHint={`${message.length} / ${MAX_MESSAGE}`}
          onChange={(event) => setMessage(event.target.value)}
        />
      </Field>

      <SectionHeading className="mt-14">How they will reach us</SectionHeading>
      <MicroLabel className="mb-3">Drop off</MicroLabel>
      <ChipGroup
        aria-label="How the items will reach us"
        value={[dropOff]}
        onValueChange={(next) => {
          if (next[0]) setDropOff(next[0] as QuoteDropOff)
        }}
      >
        {(Object.keys(DROP_OFF_LABEL) as QuoteDropOff[]).map((option) => (
          <Chip key={option} value={option}>
            {DROP_OFF_LABEL[option]}
          </Chip>
        ))}
      </ChipGroup>
      <p className="mt-4 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
        {dropOff === "post"
          ? "We will send you the address once the offer is agreed. Post is at your own risk, so send it tracked."
          : "Bring them to the shop in Bolsover once the offer is agreed."}
      </p>

      {error ? <FieldError className="mt-8">{error}</FieldError> : null}

      <div className="mt-14 hidden min-[900px]:block">{primary}</div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}
