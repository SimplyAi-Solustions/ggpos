/**
 * Settings, "Card reader": the Solo the till sends a card payment to.
 *
 * Pairing is the only thing set here. The merchant code and the SumUp API
 * key live on the server and never reach this browser, exactly as the price
 * source keys do, so there is nowhere on this page to type one.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { listReaders, pairReader, removeReader } from "@/lib/api/checkouts"
import { refusalOrFallback } from "@/lib/api/refusal"
import { saveSettings } from "@/lib/api/settings"
import type { SettingsRecord, SumUpReader } from "@/lib/api/types"

/** SumUp's own status, in words that say what to do about it. */
const STATUS: Record<SumUpReader["status"], string> = {
  paired: "Paired",
  processing: "Pairing",
  expired: "Expired. Pair it again.",
  unknown: "Not answering",
}

export function CardReader({ settings }: { settings: SettingsRecord }) {
  const queryClient = useQueryClient()
  const [code, setCode] = React.useState("")
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const readers = useQuery({
    queryKey: ["sumup-readers"],
    queryFn: listReaders,
    staleTime: 60_000,
    retry: false,
  })

  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: ["sumup-readers"] })
    void queryClient.invalidateQueries({ queryKey: ["settings"] })
    void queryClient.invalidateQueries({ queryKey: ["vault-config"] })
  }

  const pair = useMutation({
    mutationFn: () => pairReader(code.trim(), name.trim() || undefined),
    onSuccess: (reader) => {
      setCode("")
      setName("")
      setError(null)
      setNote(`${reader.name} is paired.`)
      settled()
    },
    onError: (fault) => {
      setNote(null)
      setError(
        refusalOrFallback(
          fault,
          "That reader could not be paired. Read the code off it again and try once more."
        )
      )
    },
  })

  const forget = useMutation({
    mutationFn: (id: string) => removeReader(id),
    onSuccess: () => {
      setError(null)
      setNote("The reader has been removed.")
      settled()
    },
    onError: (fault) => {
      setNote(null)
      setError(
        refusalOrFallback(fault, "That reader could not be removed. Try again.")
      )
    },
  })

  const choose = useMutation({
    // Only the two reader fields: the server merges them, and echoing the
    // merchant code from whatever this page loaded would write a stale one
    // back over a change made in the dashboard since.
    mutationFn: (reader: SumUpReader) =>
      saveSettings(settings.id, {
        sumup: { default_reader_id: reader.id, default_reader_name: reader.name },
      }),
    onSuccess: (_result, reader) => {
      setError(null)
      setNote(`Card payments go to ${reader.name}.`)
      settled()
    },
    onError: (fault) => {
      setNote(null)
      setError(
        refusalOrFallback(fault, "That reader could not be chosen. Try again.")
      )
    },
  })

  const list = readers.data?.readers ?? []
  const defaultId =
    readers.data?.default_reader_id || settings.sumup?.default_reader_id || ""

  if (readers.isError) {
    return (
      <p
        role="alert"
        data-testid="reader-error"
        className="max-w-[56ch] text-[15px] leading-[1.5] text-destructive"
      >
        {refusalOrFallback(
          readers.error,
          "The paired readers could not be read. Check the connection and try again."
        )}
      </p>
    )
  }

  if (readers.data?.not_configured) {
    return (
      <p
        data-testid="reader-not-configured"
        className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2"
      >
        SumUp is not set up, so there is nothing to pair a reader to. The
        merchant code and the API key are held on the server, in the
        PocketBase dashboard under the settings record.
      </p>
    )
  }

  return (
    <div data-testid="card-reader">
      <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        The Solo the till sends a card payment to, so nobody keys an amount in
        twice. The API key is held on the server and is never sent to this
        browser.
      </p>

      {readers.isPending ? (
        <p className="text-[15px] text-muted-foreground-2">Reading the readers.</p>
      ) : list.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          No reader is paired yet. Pair one below and the Sell screen will offer
          to take the card payment on it.
        </p>
      ) : (
        <ul data-testid="reader-list">
          {list.map((reader) => (
            <li
              key={reader.id}
              className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft py-4 first:border-t"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[15px] text-foreground">
                  {reader.name}
                </span>
                <Hint>
                  {[reader.model, STATUS[reader.status]].filter(Boolean).join(" · ")}
                </Hint>
              </span>
              {reader.id === defaultId ? (
                <Badge variant="outline">In use</Badge>
              ) : (
                <Button
                  variant="text"
                  loading={choose.isPending && choose.variables?.id === reader.id}
                  onClick={() => choose.mutate(reader)}
                >
                  Use this reader
                </Button>
              )}
              <Button
                variant="text-destructive"
                loading={forget.isPending && forget.variables === reader.id}
                onClick={() => forget.mutate(reader.id)}
              >
                <span className="sr-only">Remove {reader.name}</span>
                <span aria-hidden="true">Remove</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 flex flex-col gap-10">
        <Field
          label="Pairing code"
          htmlFor="reader-code"
          hint="From the reader"
          error={null}
        >
          <Input
            id="reader-code"
            value={code}
            maxLength={9}
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD1234"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase())
              setError(null)
              setNote(null)
            }}
          />
          <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            On the Solo, open Connections, then API, then Connect. The code
            changes every time and lasts five minutes.
          </p>
        </Field>

        <Field label="Name" htmlFor="reader-name" hint="Optional">
          <Input
            id="reader-name"
            value={name}
            maxLength={60}
            autoComplete="off"
            placeholder="Counter Solo"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>

      <FieldError>{error}</FieldError>
      {note && !error ? (
        <p
          data-testid="reader-note"
          aria-live="polite"
          className="mt-6 text-[13px] text-muted-foreground"
        >
          {note}
        </p>
      ) : null}

      <div className="mt-8">
        <Button
          variant="text"
          data-testid="pair-reader"
          loading={pair.isPending}
          onClick={() => {
            if (!code.trim()) {
              setError("Type the pairing code shown on the reader.")
              return
            }
            pair.mutate()
          }}
        >
          Pair reader
        </Button>
      </div>
    </div>
  )
}
