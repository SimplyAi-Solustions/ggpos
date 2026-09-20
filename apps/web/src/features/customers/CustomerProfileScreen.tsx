import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useStaff } from "@/lib/auth"
import { StepUpDialog } from "@/features/customers/StepUpDialog"
import { IdPhotoSheet } from "@/features/customers/IdPhotoSheet"
import {
  ALL_FLAGS,
  FLAG_LABEL,
  ID_STATUS_LABEL,
  formatDate,
  formatShortDate,
} from "@/features/customers/format"
import {
  eraseCustomer,
  getCreditLedger,
  getCustomer,
  getCustomerTradeIns,
  mergeCustomers,
  refusalOrFallback,
  updateCustomer,
  type CustomerFlag,
  type CustomerProfile,
  type IdStatus,
} from "@/lib/api"

/** One underlined field that saves what changed the moment it is left. */
function InlineField({
  id,
  label,
  value,
  type = "text",
  placeholder,
  numeric = false,
  onSave,
}: {
  id: string
  label: string
  value: string
  type?: string
  placeholder?: string
  numeric?: boolean
  onSave: (next: string) => void
}) {
  // Adjusted during render rather than in an effect: when the saved value
  // comes back changed, the box catches up on the same pass, with no extra
  // paint showing the old text.
  const [draft, setDraft] = React.useState(value)
  const [saved, setSaved] = React.useState(value)
  if (value !== saved) {
    setSaved(value)
    setDraft(value)
  }

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="cursor-pointer font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-muted-foreground uppercase"
      >
        {label}
      </label>
      <Input
        id={id}
        type={type}
        autoComplete="off"
        className={numeric ? "tnum" : undefined}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== value.trim()) onSave(draft.trim())
        }}
      />
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3 last:border-b-0">
      <MicroLabel>{label}</MicroLabel>
      <span className="text-[15px] text-foreground">{children}</span>
    </div>
  )
}

const MOVED_LABEL: Record<string, string> = {
  trade_ins: "trade-in",
  sales: "sale",
  quotes: "quote",
  credit_ledger: "credit entry",
  points_ledger: "points entry",
  want_list: "want list row",
}

/** "Moved 3 trade-ins and 1 credit entry." Nothing at zero is listed. */
export function movedSentence(moved: Record<string, number>): string {
  const parts = Object.entries(moved)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const word = MOVED_LABEL[key] ?? key.replace(/_/g, " ")
      return `${count} ${word}${count === 1 ? "" : "s"}`
    })
  if (parts.length === 0) return "The two cards are now one. There was nothing to move."
  if (parts.length === 1) return `Moved ${parts[0]}.`
  const last = parts[parts.length - 1]
  return `Moved ${parts.slice(0, -1).join(", ")} and ${last}.`
}

function idBadge(status: IdStatus) {
  // The testid sits on the wrapper: Badge renders through Base UI's
  // useRender, which does not carry stray attributes onto the element.
  return (
    <span data-testid="id-status">
      <Badge variant="outline">{ID_STATUS_LABEL[status]}</Badge>
    </span>
  )
}

export interface CustomerProfileScreenProps {
  /** The GGC code from the URL, or the record id. */
  code: string
}

/**
 * Everything the counter knows about one person, in the order a conversation
 * across the counter goes: who they are, whether their ID is good, what they
 * have sold us, what credit they hold, what staff have noted, and only then
 * the things that cannot be undone.
 *
 * Sections are divided by whitespace and a tracked micro heading. There are
 * no cards here, and no boxes: the hairline under each row is the only rule.
 */
export function CustomerProfileScreen({ code }: CustomerProfileScreenProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const staff = useStaff()
  const isAdmin = staff?.role === "admin"

  const [photoOpen, setPhotoOpen] = React.useState(false)
  const [mergeTarget, setMergeTarget] = React.useState<string | null>(null)
  const [eraseOpen, setEraseOpen] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [cardNote, setCardNote] = React.useState<string | null>(null)

  const profileQuery = useQuery({
    queryKey: ["customer", code],
    queryFn: () => getCustomer(code),
  })
  const profile = profileQuery.data ?? null
  const customerId = profile?.customer.id ?? ""

  const { data: tradeIns = [] } = useQuery({
    queryKey: ["customer-trade-ins", customerId],
    queryFn: () => getCustomerTradeIns(customerId),
    enabled: Boolean(customerId),
  })

  const { data: ledger = [] } = useQuery({
    queryKey: ["customer-credit", customerId],
    queryFn: () => getCreditLedger(customerId),
    enabled: Boolean(customerId),
  })

  function apply(next: CustomerProfile) {
    queryClient.setQueryData(["customer", code], next)
    void queryClient.invalidateQueries({ queryKey: ["customers"] })
  }

  const patch = useMutation({
    mutationFn: (values: Parameters<typeof updateCustomer>[1]) =>
      updateCustomer(customerId, values),
    onSuccess: (next) => {
      setSaveError(null)
      apply(next)
    },
    onError: (error) =>
      setSaveError(
        refusalOrFallback(error, "That change did not save. Try it again.")
      ),
  })

  if (profileQuery.isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <SkeletonText lines={6} />
      </section>
    )
  }

  if (!profile) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>No such customer</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          {displayCode(code)} does not match a card. Check the code, or search
          by name.
        </p>
        <div className="mt-10">
          <Button
            type="button"
            trailingArrow
            onClick={() => void navigate({ to: "/counter/customers" })}
          >
            Back to customers
          </Button>
        </div>
      </section>
    )
  }

  const { customer } = profile
  const priv = profile.private
  const idStatus = (priv?.id_status ?? "none") as IdStatus
  const flags = priv?.flags ?? []
  const credit = priv?.credit_balance ?? 0

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>{customer.name}</PageTitle>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="tnum font-mono text-[13px] text-muted-foreground">
          {displayCode(customer.code)}
        </span>
        <Badge variant="volt">{priv?.tier ? priv.tier : "Member"}</Badge>
        {flags.map((flag) => (
          <Badge key={flag} variant="outline">
            {FLAG_LABEL[flag]}
          </Badge>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap items-end gap-x-14 gap-y-6">
        <div>
          <MicroLabel className="mb-2">Store credit</MicroLabel>
          <p
            data-testid="credit-balance"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(credit)}
          </p>
        </div>
        <div>
          <MicroLabel className="mb-2">Guild points</MicroLabel>
          <p className="tnum font-mono text-[20px] leading-none text-foreground">
            {(priv?.points_balance ?? 0).toLocaleString("en-GB")}
          </p>
        </div>
        <div>
          <MicroLabel className="mb-2">Last visit</MicroLabel>
          <p className="tnum font-mono text-[20px] leading-none text-foreground">
            {formatShortDate(profile.lastVisit) || "None yet"}
          </p>
        </div>
      </div>

      {/* ---- Contact ---------------------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">Contact</SectionHeading>
        <div className="flex max-w-[34rem] flex-col gap-8">
          <InlineField
            id="profile-name"
            label="Name"
            value={customer.name}
            onSave={(name) => patch.mutate({ name })}
          />
          <InlineField
            id="profile-phone"
            label="Phone"
            type="tel"
            numeric
            placeholder="Not on file"
            value={customer.phone ?? ""}
            onSave={(phone) => patch.mutate({ phone })}
          />
          <InlineField
            id="profile-email"
            label="Email"
            type="email"
            placeholder="Not on file"
            value={customer.email ?? ""}
            onSave={(email) => patch.mutate({ email })}
          />
          <InlineField
            id="profile-address"
            label="Address"
            placeholder="Needed before a cash buy-in"
            value={priv?.address ?? ""}
            onSave={(address) => patch.mutate({ address })}
          />
          <div className="flex items-center gap-4">
            <Switch
              checked={customer.marketing_consent ?? false}
              onCheckedChange={(next) => patch.mutate({ marketingConsent: next })}
              aria-label="Send offers and news to this customer"
            />
            <span className="text-[15px] text-muted-foreground">
              Send offers and news
            </span>
          </div>
        </div>
        {saveError ? (
          <p role="alert" className="mt-5 text-[13px] text-destructive">
            {saveError}
          </p>
        ) : null}
      </div>

      {/* ---- ID on file ------------------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">ID on file</SectionHeading>
        <div className="max-w-[34rem]">
          <Row label="Status">{idBadge(idStatus)}</Row>
          <Row label="Type">{priv?.id_type || "-"}</Row>
          <Row label="Expires">
            <span className="tnum">{formatDate(priv?.id_expiry) || "-"}</span>
          </Row>
          <Row label="Last four">
            <span className="tnum font-mono text-[13px]">
              {priv?.id_ref_last4 || "-"}
            </span>
          </Row>
          <Row label="Verified">
            <span className="tnum">
              {priv?.id_verified_at
                ? `${formatDate(priv.id_verified_at)}${
                    priv.id_verified_by ? ` by ${priv.id_verified_by}` : ""
                  }`
                : "-"}
            </span>
          </Row>
        </div>
        {isAdmin && idStatus === "verified" ? (
          <div className="mt-6">
            <Button variant="text" type="button" onClick={() => setPhotoOpen(true)}>
              View photo
            </Button>
          </div>
        ) : null}
      </div>

      {/* ---- Trade-ins -------------------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">Trade-ins</SectionHeading>
        {tradeIns.length === 0 ? (
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
            Nothing bought in from this customer yet.
          </p>
        ) : (
          <ul className="max-w-[40rem]">
            {tradeIns.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3"
              >
                <Link
                  to="/counter/trade/$id/receipt"
                  params={{ id: entry.id }}
                  className="tnum font-mono text-[13px] text-foreground underline-offset-4 outline-none hover:underline"
                >
                  {entry.number}
                </Link>
                <span className="text-[13px] text-muted-foreground-2">
                  {formatShortDate(entry.at)}
                </span>
                <span className="tnum text-[15px] text-foreground">
                  {formatGBP(entry.payoutCash + entry.payoutCredit)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Credit ----------------------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">Credit</SectionHeading>
        {ledger.length === 0 ? (
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
            No credit has been issued or spent.
          </p>
        ) : (
          <ul className="max-w-[40rem]">
            {ledger.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3"
              >
                <span className="text-[15px] text-foreground capitalize">
                  {row.reason.replace("_", " ")}
                </span>
                <span className="tnum font-mono text-[13px] text-muted-foreground-2">
                  {row.ref || formatShortDate(row.created)}
                </span>
                <span className="tnum text-[15px] text-foreground">
                  {formatGBP(row.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Notes and flags -------------------------------------------- */}
      <div className="mt-24">
        <SectionHeading className="mt-0">Notes and flags</SectionHeading>
        <div className="max-w-[34rem]">
          <Textarea
            id="profile-notes"
            aria-label="Staff notes about this customer"
            maxLength={500}
            placeholder="Anything the next person on the counter needs to know"
            defaultValue={priv?.notes ?? ""}
            onBlur={(event) => {
              if (event.target.value !== (priv?.notes ?? "")) {
                patch.mutate({ notes: event.target.value })
              }
            }}
          />
          <div className="mt-8">
            <MicroLabel className="mb-3">Flags</MicroLabel>
            <ChipGroup
              aria-label="Flags"
              multiple
              value={flags}
              onValueChange={(next) =>
                patch.mutate({ flags: next as CustomerFlag[] })
              }
            >
              {ALL_FLAGS.map((flag) => (
                <Chip key={flag} value={flag}>
                  {FLAG_LABEL[flag]}
                </Chip>
              ))}
            </ChipGroup>
          </div>
          <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground-2">
            Staff only. Never shown in My Vault.
          </p>
        </div>
      </div>

      {/* ---- Duplicates -------------------------------------------------- */}
      {profile.duplicates.length > 0 ? (
        <div className="mt-24">
          <SectionHeading className="mt-0">Duplicates</SectionHeading>
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
            These customers share this phone number or email address. Merging
            moves their trade-ins, credit, points and want list here and removes
            the other card.
          </p>
          <ul className="mt-6 max-w-[40rem]">
            {profile.duplicates.map((duplicate) => (
              <li
                key={duplicate.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-hairline-soft py-4"
              >
                <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <Link
                    to="/counter/customers/$code"
                    params={{ code: duplicate.code }}
                    className="text-[15px] text-foreground underline-offset-4 outline-none hover:underline"
                  >
                    {duplicate.name}
                  </Link>
                  <span className="tnum font-mono text-[13px] text-muted-foreground-2">
                    {displayCode(duplicate.code)}
                  </span>
                </span>
                <Button
                  variant="text"
                  type="button"
                  onClick={() => setMergeTarget(duplicate.id)}
                >
                  Merge into this
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---- The card, and the end of the road --------------------------- */}
      <div className="mt-24 flex flex-wrap items-center gap-x-10 gap-y-5">
        <Button
          variant="text"
          type="button"
          onClick={() =>
            void navigate({
              to: "/counter/customers/$code/card",
              params: { code: customer.code },
            })
          }
        >
          Print card
        </Button>
        {customer.email ? (
          <Button
            variant="text"
            type="button"
            onClick={() =>
              setCardNote(
                "Emailing the card waits on the server's mail route. Print it, or read them the portal link."
              )
            }
          >
            Email card
          </Button>
        ) : null}
        {isAdmin ? (
          <Button
            variant="text-destructive"
            type="button"
            onClick={() => setEraseOpen(true)}
          >
            Erase
          </Button>
        ) : (
          <p className="text-[13px] leading-[1.45] text-muted-foreground-2">
            Erasing a customer is an admin job. Ask Richard.
          </p>
        )}
        {cardNote ? (
          <p
            aria-live="polite"
            className="max-w-[46ch] text-[13px] leading-[1.45] text-muted-foreground"
          >
            {cardNote}
          </p>
        ) : null}
      </div>

      <IdPhotoSheet
        open={photoOpen}
        onOpenChange={setPhotoOpen}
        customerId={customerId}
        customerName={customer.name}
      />

      <StepUpDialog
        open={mergeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMergeTarget(null)
        }}
        title="Merge customers"
        description={`Everything on the other card moves to ${customer.name}, and the other card is removed. This cannot be undone, so confirm your password.`}
        confirmLabel="Merge"
        onConfirm={async (token) => {
          if (!mergeTarget) return null
          const result = await mergeCustomers(customerId, mergeTarget, token)
          apply(result.profile)
          void queryClient.invalidateQueries({ queryKey: ["customer-credit"] })
          void queryClient.invalidateQueries({ queryKey: ["customer-trade-ins"] })
          return movedSentence(result.moved)
        }}
      />

      <StepUpDialog
        open={eraseOpen}
        onOpenChange={setEraseOpen}
        title="Erase this customer"
        description="The name, phone, email, address and notes are replaced with nothing, the ID photo is deleted, open rewards are cancelled and the want list, quotes and notifications go. Numbered trade-ins and sales keep their seller details, because tax law requires the shop to hold them for six years. Confirm your password to go ahead."
        confirmLabel="Erase"
        onConfirm={async (token) => {
          apply(await eraseCustomer(customerId, token))
          return "That customer has been erased. The numbered records are kept."
        }}
      />
    </section>
  )
}
