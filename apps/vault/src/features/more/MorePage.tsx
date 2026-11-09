import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, LogOut, Settings } from "lucide-react"

import { initials, signOut, useStaff } from "@/lib/auth"
import { ThemeToggle } from "@/shell/ThemeToggle"
import { Badge, Button, PageHeader, Panel } from "@/ui"

export function MorePage() {
  const staff = useStaff()
  const navigate = useNavigate()

  return (
    <section className="flex flex-col gap-4">
      <PageHeader eyebrow="You" title="More" />

      {staff && (
        <Panel className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-pop font-mono font-bold text-on-pop">
            {initials(staff.name || staff.email)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{staff.name || "Staff"}</p>
            <p className="truncate text-sm text-fg-2">{staff.email}</p>
          </div>
          <Badge tone="volt">{staff.role}</Badge>
        </Panel>
      )}

      <Panel flush className="overflow-hidden">
        <Link
          to="/settings"
          className="flex h-14 items-center gap-3 px-4 transition-colors hover:bg-line"
        >
          <Settings className="size-5 text-fg-2" aria-hidden />
          <span className="flex-1 font-medium">Settings</span>
          <ChevronRight className="size-5 text-fg-3" aria-hidden />
        </Link>
      </Panel>

      <Panel className="flex flex-col gap-3">
        <p className="label-mono text-fg-2">Theme</p>
        <ThemeToggle block />
      </Panel>

      <Button
        variant="secondary"
        size="lg"
        block
        icon={<LogOut className="size-5" aria-hidden />}
        onClick={() => {
          signOut()
          void navigate({ to: "/login" })
        }}
      >
        Sign out
      </Button>
    </section>
  )
}
