/**
 * Settings, Agents (docs/api-contract-launch.md, section 5; docs/agents.md).
 *
 * AI agents with full admin access, such as Gandalf on Buzz. Everything
 * here takes effect the moment it is done, not on the page's Save:
 * - **Agents**: each with its note, when its token runs out and when it
 *   last did anything. Add an agent (the admin's password confirms it), give
 *   one a new token (the old one stops at once), switch one off (its token
 *   stops at once; on again, it needs a new one), and read its last 50
 *   actions from the audit log.
 * - **The token**, shown once after Add or New token, with Copy and the
 *   Hermes `config.yaml` block for both ways in: straight to the MCP
 *   endpoint, or through the stdio bridge. Closing the sheet forgets it.
 * - **Research webhook**: the address GG Vault posts a new research request
 *   to, signed with a secret the server never shows again.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { hermesConfig } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { StepUpCancelled, stepUp } from "@/lib/auth-stepup"
import {
  agentActions,
  agentKeys,
  createAgent,
  getAgentWebhook,
  listAgents,
  makeWebhookSecret,
  rekeyAgent,
  saveAgentWebhook,
  updateAgent,
  vaultBaseUrl,
  type AgentSummary,
  type AgentTokenIssued,
} from "@/lib/api/agents"
import { refusalOrFallback } from "@/lib/api/refusal"
import { formatDate, formatDateTime } from "@/lib/dates"

const NOTE = "max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2"

function Note({ children }: { children: React.ReactNode }) {
  return <p className={NOTE}>{children}</p>
}

/** What an audit row's action means, in words. */
const ACTION_WORDS: Record<string, string> = {
  mcp_call: "Tool call",
  research_requested: "Asked for research",
  research_claimed: "Claimed research",
  research_completed: "Completed research",
  research_cancelled: "Cancelled research",
  research_webhook: "Woke the agent",
  uk_comp: "Added a UK sold comp",
  refresh_prices: "Refreshed prices",
  sale_completed: "Completed a sale",
  trade_in_completed: "Completed a buy-in",
}

function actionWords(action: string): string {
  const known = ACTION_WORDS[action]
  if (known) return known
  const words = action.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

function useCopy() {
  const [copied, setCopied] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  async function copy(key: string, text: string) {
    setFailed(false)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
    } catch {
      // A browser that refuses the clipboard: the text is selectable on the page.
      setFailed(true)
    }
  }
  return { copied, failed, copy }
}

function Block({ testId, children }: { testId: string; children: string }) {
  return (
    <pre
      data-testid={testId}
      className="overflow-x-auto border-y border-hairline-soft py-3 font-mono text-[13px] leading-[1.6] break-all whitespace-pre-wrap text-foreground select-all"
    >
      {children}
    </pre>
  )
}

/** The token, shown once, and the Hermes config that carries it. */
function TokenReveal({ issued, rotated }: { issued: AgentTokenIssued; rotated: boolean }) {
  const { copied, failed, copy } = useCopy()
  const config = hermesConfig({ baseUrl: vaultBaseUrl(), token: issued.token })

  return (
    <SheetBody>
      <div className="flex flex-col gap-8">
        <div>
          <MicroLabel className="mb-3">Token</MicroLabel>
          <p
            data-testid="agent-token"
            className="border-b border-hairline pb-3 font-mono text-[13px] leading-[1.6] break-all text-foreground select-all"
          >
            {issued.token}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            <Button variant="text" type="button" onClick={() => void copy("token", issued.token)}>
              {copied === "token" ? "Copied" : "Copy token"}
            </Button>
            <span className="tnum text-[13px] text-muted-foreground-2">
              Works until {formatDate(issued.expires_at)}.
            </span>
          </div>
          {rotated ? (
            <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
              The old token has stopped working. Put this one where it was.
            </p>
          ) : null}
        </div>

        <div>
          <MicroLabel className="mb-2">Hermes config.yaml</MicroLabel>
          <Note>Paste one of these under mcp_servers in ~/.hermes/config.yaml, then restart Hermes.</Note>
          <Hint className="mt-5 mb-2">Over HTTPS</Hint>
          <Block testId="hermes-http">{config.http}</Block>
          <Button variant="text" type="button" className="mt-3" onClick={() => void copy("http", config.http)}>
            {copied === "http" ? "Copied" : "Copy"}
          </Button>
          <Hint className="mt-6 mb-2">Through the stdio bridge</Hint>
          <Block testId="hermes-stdio">{config.stdio}</Block>
          <Button variant="text" type="button" className="mt-3" onClick={() => void copy("stdio", config.stdio)}>
            {copied === "stdio" ? "Copied" : "Copy"}
          </Button>
          <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            Point the path at services/mcp/stdio.mjs on the agent&rsquo;s machine. docs/agents.md has the rest.
          </p>
        </div>

        {failed ? (
          <p role="alert" className="text-[13px] text-destructive">
            Your browser would not copy it. Select the text and copy it by hand.
          </p>
        ) : null}
      </div>
    </SheetBody>
  )
}

// ---------------------------------------------------------------------------
// Adding an agent
// ---------------------------------------------------------------------------

function AddAgentForm({
  onIssued,
  onCancel,
}: {
  onIssued: (issued: AgentTokenIssued) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState("")
  const [note, setNote] = React.useState("")
  const [problem, setProblem] = React.useState<{ field: "name" | "form"; message: string } | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) {
      setProblem({ field: "name", message: "Give the agent a name, for example Gandalf." })
      return
    }
    setProblem(null)
    setBusy(true)
    try {
      onIssued(await createAgent({ name: clean, note: note.trim() }, await stepUp()))
    } catch (cause) {
      if (cause instanceof StepUpCancelled) return
      setProblem({ field: "form", message: refusalOrFallback(cause, "The agent was not added. Try again.") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="Add an agent">
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field
            layout="stacked"
            label="Name"
            htmlFor="agent-name"
            error={problem?.field === "name" ? problem.message : null}
          >
            <Input
              id="agent-name"
              autoFocus
              autoComplete="off"
              maxLength={60}
              placeholder="Gandalf"
              value={name}
              aria-invalid={problem?.field === "name" ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field layout="stacked" label="Note" htmlFor="agent-note">
            <Textarea
              id="agent-note"
              maxLength={500}
              placeholder="Hermes on the Mac Mini, through Buzz"
              trailingHint={`${note.length} / 500`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
        <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          An agent has full admin access. Your password confirms it. Its token is shown once, next.
        </p>
        {problem?.field === "form" ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {problem.message}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Add agent
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Its last 50 actions
// ---------------------------------------------------------------------------

function ActionsList({ agent }: { agent: AgentSummary }) {
  const actions = useQuery({
    queryKey: agentKeys.actions(agent.id),
    queryFn: () => agentActions(agent.id),
    staleTime: 10_000,
  })
  return (
    <SheetBody>
      {actions.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : actions.error ? (
        <p role="alert" className="text-[15px] text-destructive">
          {refusalOrFallback(actions.error, "The actions would not load. Try again.")}
        </p>
      ) : (actions.data ?? []).length === 0 ? (
        <p className="text-[15px] text-muted-foreground-2">{agent.name} has not done anything yet.</p>
      ) : (
        <ul data-testid="agent-actions">
          {(actions.data ?? []).map((row) => (
            <li key={row.id} className="flex flex-col gap-1 border-b border-hairline-soft py-3 first:border-t">
              <span className="flex flex-wrap items-baseline justify-between gap-x-6">
                <span className="text-[15px] text-foreground">{actionWords(row.action)}</span>
                <span className="tnum font-mono text-[13px] text-muted-foreground-2">
                  {formatDateTime(row.created)}
                </span>
              </span>
              {row.detail ? (
                <span className="text-[13px] leading-[1.45] text-muted-foreground-2">{row.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SheetBody>
  )
}

// ---------------------------------------------------------------------------
// One agent
// ---------------------------------------------------------------------------

function AgentLine({
  agent,
  onIssued,
  onActions,
  onChanged,
}: {
  agent: AgentSummary
  onIssued: (issued: AgentTokenIssued) => void
  onActions: () => void
  onChanged: () => void
}) {
  const [confirming, setConfirming] = React.useState<"rekey" | "off" | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function rekey() {
    setBusy(true)
    setError(null)
    try {
      onIssued(await rekeyAgent(agent.id, await stepUp()))
      setConfirming(null)
      onChanged()
    } catch (cause) {
      if (cause instanceof StepUpCancelled) return
      setError(refusalOrFallback(cause, "No new token was made. Try again."))
    } finally {
      setBusy(false)
    }
  }

  async function switchTo(active: boolean) {
    setBusy(true)
    setError(null)
    try {
      await updateAgent(agent.id, { active })
      setConfirming(null)
      onChanged()
    } catch (cause) {
      setError(refusalOrFallback(cause, "The agent did not change. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const tokenWords = agent.token_expires_at
    ? `Token works until ${formatDate(agent.token_expires_at)}`
    : "No working token. Give it a new one"
  const lastWords = agent.last_action_at ? `Last action ${formatDateTime(agent.last_action_at)}` : "Nothing done yet"

  return (
    <li data-testid="agent-row" className="border-b border-hairline-soft py-4 first:border-t">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-baseline gap-3">
            <span className="text-[15px] text-foreground">{agent.name}</span>
            {agent.active ? null : <Hint>Switched off</Hint>}
          </span>
          {agent.note ? (
            <span className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">{agent.note}</span>
          ) : null}
          <span className="tnum text-[13px] leading-[1.45] text-muted-foreground-2">
            {agent.active ? `${tokenWords}. ${lastWords}.` : `Switched off. ${lastWords}.`}
          </span>
        </span>
        {confirming ? null : (
          <span className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Button variant="text" aria-label={`Actions by ${agent.name}`} onClick={onActions}>
              Actions
            </Button>
            {agent.active ? (
              <>
                <Button variant="text" aria-label={`New token for ${agent.name}`} onClick={() => setConfirming("rekey")}>
                  New token
                </Button>
                <Button
                  variant="text-destructive"
                  aria-label={`Switch off ${agent.name}`}
                  onClick={() => setConfirming("off")}
                >
                  Switch off
                </Button>
              </>
            ) : (
              <Button
                variant="text"
                aria-label={`Switch on ${agent.name}`}
                loading={busy}
                onClick={() => void switchTo(true)}
              >
                Switch on
              </Button>
            )}
          </span>
        )}
      </div>
      {confirming ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
            {confirming === "rekey"
              ? `${agent.name}'s current token stops working at once. Put the new one in its config straight after.`
              : `${agent.name} stops at once. Switching it back on needs a new token.`}
          </p>
          <span className="flex flex-wrap items-center gap-6">
            {confirming === "rekey" ? (
              <Button
                variant="text-destructive"
                aria-label={`Make a new token for ${agent.name}`}
                loading={busy}
                onClick={() => void rekey()}
              >
                Make new token
              </Button>
            ) : (
              <Button
                variant="text-destructive"
                aria-label={`Switch ${agent.name} off now`}
                loading={busy}
                onClick={() => void switchTo(false)}
              >
                Switch it off
              </Button>
            )}
            <Button variant="text" onClick={() => setConfirming(null)}>
              Keep
            </Button>
          </span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The research webhook
// ---------------------------------------------------------------------------

function WebhookForm() {
  const queryClient = useQueryClient()
  const webhook = useQuery({ queryKey: agentKeys.webhook, queryFn: getAgentWebhook, staleTime: 60_000 })
  const [url, setUrl] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const shownUrl = url ?? webhook.data?.url ?? ""
  const secretSet = webhook.data?.secret_set ?? false

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    const cleanUrl = shownUrl.trim()
    if (cleanUrl && !/^https?:\/\/\S+$/i.test(cleanUrl)) {
      setError("Give the webhook an http or https address.")
      return
    }
    if (secret.trim() && secret.trim().length < 16) {
      setError("Make the secret 16 characters or more, or press Make a secret.")
      return
    }
    setBusy(true)
    try {
      const next = await saveAgentWebhook({ url: cleanUrl, secret: secret.trim() || undefined })
      queryClient.setQueryData(agentKeys.webhook, next)
      setUrl(null)
      setSaved(true)
    } catch (cause) {
      setError(refusalOrFallback(cause, "The webhook did not save. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} aria-label="Research webhook" data-testid="agent-webhook">
      <MicroLabel tone="ink" className="mb-4">
        Research webhook
      </MicroLabel>
      <Note>
        When somebody asks for research, GG Vault posts the request here, signed with the secret, so
        the agent starts at once rather than waiting to be asked. docs/agents.md has the Hermes route.
      </Note>
      <div className="mt-8 flex flex-col gap-8">
        <Field label="Address" htmlFor="webhook-url">
          <Input
            id="webhook-url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
            placeholder="http://mac-mini:8644/webhooks/ggvault-research"
            value={shownUrl}
            onChange={(event) => {
              setSaved(false)
              setUrl(event.target.value)
            }}
          />
        </Field>
        <Field label="Secret" htmlFor="webhook-secret">
          <Input
            id="webhook-secret"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            className="font-mono text-[13px]"
            placeholder={secretSet ? "Set. Leave blank to keep it." : "Not set"}
            value={secret}
            onChange={(event) => {
              setSaved(false)
              setSecret(event.target.value)
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-6">
            <Button
              variant="text"
              type="button"
              onClick={() => {
                setSaved(false)
                setSecret(makeWebhookSecret())
              }}
            >
              Make a secret
            </Button>
            {secret ? (
              <span className="text-[13px] text-muted-foreground-2">Copy it into the Hermes route before you leave.</span>
            ) : null}
          </div>
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-6 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-6">
        <Button variant="text" type="submit" loading={busy}>
          Save webhook
        </Button>
        {saved ? (
          <span data-testid="webhook-saved" aria-live="polite" className="text-[13px] text-muted-foreground">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

type SheetState =
  | { kind: "add" }
  | { kind: "token"; issued: AgentTokenIssued; rotated: boolean }
  | { kind: "actions"; agent: AgentSummary }
  | null

export function AgentsSection() {
  const queryClient = useQueryClient()
  const [sheet, setSheet] = React.useState<SheetState>(null)
  const agents = useQuery({ queryKey: agentKeys.all, queryFn: listAgents, staleTime: 15_000 })

  const refresh = () => void queryClient.invalidateQueries({ queryKey: agentKeys.all })

  return (
    <section className="mt-24" aria-labelledby="agents-heading" data-testid="agents-section">
      <SectionHeading id="agents-heading">Agents</SectionHeading>
      <Note>
        AI agents with full admin access, such as Gandalf on Buzz. Each reaches GG Vault with its own
        token, and everything it does is in the audit log under its name. An agent is never on the lock
        screen, holds no PIN and cannot open an ID photo. Everything here takes effect straight away,
        not on Save.
      </Note>

      <div className="mt-10 flex flex-col gap-14">
        <div>
          {agents.error ? (
            <p role="alert" className="text-[15px] text-destructive">
              {refusalOrFallback(agents.error, "The agents would not load. Try again.")}
            </p>
          ) : agents.isPending ? (
            <Skeleton className="h-4 w-2/3" />
          ) : (agents.data ?? []).length === 0 ? (
            <p className="text-[15px] text-muted-foreground-2">No agent is set up yet.</p>
          ) : (
            <ul data-testid="agent-list">
              {(agents.data ?? []).map((agent) => (
                <AgentLine
                  key={agent.id}
                  agent={agent}
                  onChanged={refresh}
                  onActions={() => setSheet({ kind: "actions", agent })}
                  onIssued={(issued) => setSheet({ kind: "token", issued, rotated: true })}
                />
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Button variant="text" onClick={() => setSheet({ kind: "add" })}>
              Add an agent
            </Button>
          </div>
        </div>

        <WebhookForm />
      </div>

      <Sheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null)
        }}
      >
        <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
          {sheet?.kind === "add" ? (
            <>
              <SheetHeader>
                <SheetTitle>Add an agent</SheetTitle>
                <SheetDescription>
                  An AI agent such as Gandalf, with full admin access through its own token.
                </SheetDescription>
              </SheetHeader>
              <AddAgentForm
                onIssued={(issued) => {
                  refresh()
                  setSheet({ kind: "token", issued, rotated: false })
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : sheet?.kind === "token" ? (
            <>
              <SheetHeader>
                <SheetTitle>{sheet.issued.agent.name}&rsquo;s token</SheetTitle>
                <SheetDescription>
                  Shown once. Copy it now: GG Vault keeps no copy it can show again.
                </SheetDescription>
              </SheetHeader>
              <TokenReveal issued={sheet.issued} rotated={sheet.rotated} />
              <SheetFooter>
                <Button type="button" trailingArrow onClick={() => setSheet(null)}>
                  Done
                </Button>
              </SheetFooter>
            </>
          ) : sheet?.kind === "actions" ? (
            <>
              <SheetHeader>
                <SheetTitle>{sheet.agent.name}&rsquo;s last 50 actions</SheetTitle>
                <SheetDescription>From the audit log, newest first.</SheetDescription>
              </SheetHeader>
              <ActionsList agent={sheet.agent} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  )
}
