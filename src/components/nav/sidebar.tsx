import Link from "next/link";

export function Sidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-ink-200 bg-ink-50 px-3 py-5">
      <div className="px-2 pb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-ink-500">fa-amort</div>
        <div className="text-[11px] text-ink-400">Fixed assets · v0.2</div>
        <div className="mt-1 text-[10px] text-ink-400">
          companion to <span className="font-mono">ledger-core</span>
        </div>
      </div>
      <NavLink href="/">Dashboard</NavLink>
      <NavLink href="/fixed-assets">Fixed assets</NavLink>
      <NavLink href="/depreciation-runs">Depreciation runs</NavLink>
      <NavSection label="AI workflows" />
      <NavLink href="/ai-capex">Capex classifier</NavLink>
      <NavLink href="/ai-useful-life">Useful-life reassess</NavLink>
      <NavLink href="/ai-impairment">Impairment screener</NavLink>
      <NavLink href="/ai-audit">AI audit log</NavLink>
    </aside>
  );
}

function NavSection({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-ink-400">
      {label}
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-white hover:text-ink-900"
    >
      {children}
    </Link>
  );
}
