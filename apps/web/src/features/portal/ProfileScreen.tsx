import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { deleteMyAccount, downloadMyData, getMe, getPushConfig, updateMe } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push"
import { ID_STATUS_SENTENCE, MONTHS } from "@/features/portal/format"
import { signOut } from "@/features/portal/session"
import { Note } from "@/features/portal/Note"

/** The typed words that arm the delete button. */
const DELETE_PHRASE = "DELETE"

const PUSH_NOTE: Record<PushState, string> = {
  unsupported: "This browser cannot show notifications. Email still works.",
  unconfigured: "Push notifications are not switched on at the shop yet.",
  blocked:
    "Notifications are turned off for this site. Turn them on in your browser settings.",
  off: "Get a notification the moment a card on your want list comes in.",
  on: "On for this device. Turn it off here and we will stop.",
}

/**
 * Profile and privacy.
 *
 * Contact details, what we may send, what we hold and the two rights that
 * need a button of their own: download everything, and erase the profile.
 * The erasure sheet says what is kept and why before it asks for a typed
 * confirmation, which is the sentence from `docs/privacy-notice.md` rather
 * than a softer one written for the button.
 */
export function ProfileScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: me, isPending } = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const { data: push } = useQuery({
    queryKey: ["portal", "push-config"],
    queryFn: getPushConfig,
    staleTime: 10 * 60_000,
  })

  const [name, setName] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [marketing, setMarketing] = React.useState(false)
  const [birthday, setBirthday] = React.useState("")
  const [emailNotices, setEmailNotices] = React.useState(true)
  const [pushNotices, setPushNotices] = React.useState(false)
  const [state, setState] = React.useState<PushState>("off")
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [privacyOpen, setPrivacyOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [phrase, setPhrase] = React.useState("")

  // Seed the form once the record arrives, and never again: a refetch must
  // not throw away what somebody is halfway through typing.
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (!me || seeded.current) return
    seeded.current = true
    setName(me.customer.name)
    setPhone(me.customer.phone)
    setMarketing(me.customer.marketing_consent)
    setBirthday(me.customer.birthday_month ? String(me.customer.birthday_month) : "")
    setEmailNotices(me.notifications?.email ?? true)
    setPushNotices(me.notifications?.push ?? false)
  }, [me])

  const vapid = push?.vapid_public_key ?? ""
  React.useEffect(() => {
    let cancelled = false
    void pushState(vapid).then((next) => {
      if (!cancelled) {
        setState(next)
        setPushNotices(next === "on")
      }
    })
    return () => {
      cancelled = true
    }
  }, [vapid])

  const save = useMutation({
    mutationFn: () =>
      updateMe({
        name: name.trim(),
        phone: phone.trim(),
        marketing_consent: marketing,
        birthday_month: birthday ? Number(birthday) : null,
        notifications: { email: emailNotices, push: pushNotices },
      }),
    onSuccess: async () => {
      setSaved(true)
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ["portal", "me"] })
    },
    onError: (cause) => {
      setSaved(false)
      setError(refusalOrFallback(cause, "That did not save. Try again in a moment."))
    },
  })

  const erase = useMutation({
    mutationFn: deleteMyAccount,
    onSuccess: async () => {
      setDeleteOpen(false)
      signOut()
      await queryClient.clear()
      await navigate({ to: "/account" })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(
          cause,
          "Your profile could not be deleted. Ask at the counter and we will do it."
        )
      ),
  })

  async function togglePush(next: boolean) {
    setError(null)
    try {
      if (next) {
        await enablePush(vapid)
        setPushNotices(true)
        setState("on")
      } else {
        await disablePush()
        setPushNotices(false)
        setState("off")
      }
    } catch (cause) {
      setPushNotices(false)
      setError(
        refusalOrFallback(cause, "Notifications could not be turned on for this device.")
      )
    }
  }

  async function download() {
    setError(null)
    try {
      const blob = await downloadMyData()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "my-vault-data.json"
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(
        refusalOrFallback(cause, "That download could not be prepared. Try again.")
      )
    }
  }

  if (isPending || !me) {
    return (
      <section className="pt-12 sm:pt-20">
        <SkeletonText lines={6} />
      </section>
    )
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Profile</PageTitle>
      <Lede>Your details, what we send you, and what we hold.</Lede>

      <SectionHeading className="mt-14">Your details</SectionHeading>
      <FieldRow>
        <Field layout="stacked" label="Name" htmlFor="profile-name">
          <Input
            id="profile-name"
            value={name}
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field layout="stacked" label="Phone" htmlFor="profile-phone" hint="Optional">
          <Input
            id="profile-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
        <Field
          layout="stacked"
          label="Birthday month"
          htmlFor="profile-birthday"
          hint="Optional"
        >
          <Select
            value={birthday}
            onValueChange={(next) => setBirthday(String(next ?? ""))}
          >
            <SelectTrigger id="profile-birthday">
              <SelectValue placeholder="Pick a month" />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((month, index) => (
                <SelectItem key={month} value={String(index + 1)}>
                  {month}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>

      <div className="mt-8 flex flex-col gap-2">
        <MicroLabel>Email</MicroLabel>
        <p className="text-[15px] leading-[1.5] text-foreground">{me.customer.email}</p>
        <Note>This is how you sign in. Ask at the counter to change it.</Note>
      </div>

      <SectionHeading className="mt-14">What we send you</SectionHeading>
      <ul className="flex flex-col gap-8">
        <li className="flex items-start justify-between gap-6">
          <span className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor="profile-marketing"
              className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
            >
              Offers and news
            </label>
            <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
              Only if you say yes. You can stop at any time.
            </span>
          </span>
          <Switch
            id="profile-marketing"
            checked={marketing}
            onCheckedChange={setMarketing}
          />
        </li>
        <li className="flex items-start justify-between gap-6">
          <span className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor="profile-email-notices"
              className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
            >
              Email about my quotes
            </label>
            <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
              Offers, holds and buy-in receipts.
            </span>
          </span>
          <Switch
            id="profile-email-notices"
            checked={emailNotices}
            onCheckedChange={setEmailNotices}
          />
        </li>
        <li className="flex items-start justify-between gap-6">
          <span className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor="profile-push"
              className="font-mono text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase"
            >
              Push to this device
            </label>
            <span className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground-2">
              {PUSH_NOTE[state]}
            </span>
          </span>
          <Switch
            id="profile-push"
            checked={pushNotices}
            disabled={state === "unsupported" || state === "unconfigured" || state === "blocked"}
            onCheckedChange={(next) => void togglePush(next)}
          />
        </li>
      </ul>

      <SectionHeading className="mt-14">Photo ID</SectionHeading>
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        {ID_STATUS_SENTENCE[me.id_status]}
      </p>

      {error ? <FieldError className="mt-10">{error}</FieldError> : null}

      <div className="mt-14">
        <Button type="button" trailingArrow loading={save.isPending} onClick={() => save.mutate()}>
          Save changes
        </Button>
        {saved ? (
          <p role="status" className="mt-4 text-[15px] text-muted-foreground">
            Saved.
          </p>
        ) : null}
      </div>

      <SectionHeading className="mt-16">Your data</SectionHeading>
      <div className="flex flex-col items-start gap-8">
        <Button type="button" variant="text" onClick={() => void download()}>
          Download my data
        </Button>
        <Button type="button" variant="text" onClick={() => setPrivacyOpen(true)}>
          How we use your data
        </Button>
        <Button
          type="button"
          variant="text-destructive"
          onClick={() => {
            setPhrase("")
            setDeleteOpen(true)
          }}
        >
          Delete my account
        </Button>
      </div>

      <SectionHeading className="mt-16">This device</SectionHeading>
      <Button
        type="button"
        variant="text"
        onClick={() => {
          signOut()
          queryClient.clear()
          void navigate({ to: "/account" })
        }}
      >
        Sign out
      </Button>

      <Sheet open={privacyOpen} onOpenChange={setPrivacyOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>How we use your data</SheetTitle>
            <SheetDescription>
              The short version of our privacy notice.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <ul className="flex flex-col gap-6">
              {[
                {
                  heading: "Trade-in records",
                  body: "What you sold, when, and what we paid. We keep these for six years because tax law requires it.",
                },
                {
                  heading: "ID for cash buy-ins",
                  body: "If we pay you cash we record your name, address, ID type, the last four digits and the expiry, and photograph the ID to prevent and detect crime. The photo is kept for up to twelve months.",
                },
                {
                  heading: "GG Guild",
                  body: "Your purchases, points, tier and rewards, under the programme's terms. No automated decision is made about you, and a member of staff can always explain your points.",
                },
                {
                  heading: "Marketing",
                  body: "Only if you have said yes. You can withdraw that here or by asking a member of staff, and we will stop.",
                },
                {
                  heading: "Quote photos",
                  body: "Used to identify and value your items, and deleted 90 days after the quote closes.",
                },
                {
                  heading: "Who sees it",
                  body: "Staff who need it to do their job, SumUp for card payments, and our email provider. We do not sell your data.",
                },
                {
                  heading: "Your rights",
                  body: "See what we hold, correct it, delete your profile, or stop marketing at any time. Complaints go to us first, then to the Information Commissioner's Office at ico.org.uk.",
                },
              ].map((entry) => (
                <li key={entry.heading} className="flex flex-col gap-1.5">
                  <MicroLabel tone="ink">{entry.heading}</MicroLabel>
                  <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                    {entry.body}
                  </p>
                </li>
              ))}
            </ul>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="text" onClick={() => setPrivacyOpen(false)}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={deleteOpen} onOpenChange={setDeleteOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Delete my account</SheetTitle>
            <SheetDescription>
              This cannot be undone. Read what stays before you confirm.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1.5">
                <MicroLabel tone="ink">What goes</MicroLabel>
                <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                  Your name, contact details, address, date of birth, ID details
                  and ID photo, your want list, your quotes with their photos,
                  and your notifications.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <MicroLabel tone="ink">What stays, and why</MicroLabel>
                <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
                  Every numbered trade-in and sale, with the seller details
                  recorded at the time. Tax law requires us to keep these for six
                  years, and UK GDPR Article 17(3)(b) lets us.
                </p>
              </div>
              {me.balances.credit > 0 ? (
                <p className="max-w-[56ch] text-[15px] leading-[1.5] text-destructive">
                  {`You still have ${formatGBP(me.balances.credit)} store credit. Use it or ask the shop to pay it out first.`}
                </p>
              ) : null}
              <Field
                layout="stacked"
                label={`Type ${DELETE_PHRASE} to confirm`}
                htmlFor="profile-delete-phrase"
              >
                <Input
                  id="profile-delete-phrase"
                  value={phrase}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPhrase(event.target.value.toUpperCase())}
                />
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
            </div>
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="text-destructive"
              loading={erase.isPending}
              disabled={phrase !== DELETE_PHRASE || me.balances.credit > 0}
              onClick={() => erase.mutate()}
            >
              Delete my account
            </Button>
            <Button type="button" variant="text" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
