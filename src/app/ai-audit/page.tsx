// AI audit log.
//
// Every classification (and v0.3+ useful-life / impairment suggestions)
// persists to AiAssetSuggestion. This page is the bookkeeping for those
// rows — what got run, what the model said, how many tokens it cost,
// and whether the suggestion was accepted (v0.3).
//
// The decision discipline (from CLAUDE.md non-negotiable #3, mirrored
// in recon and revenue-rec): AI proposes; humans approve; ledger-core
// posts. This log is the audit trail that proves the human stayed in
// the loop.

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function AiAuditPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope via the tenantId
  // column on AiAssetSuggestion. Pending CAPEX classifications (assetId
  // null) now show up correctly for their owning tenant. Legacy rows
  // (tenantId null) are filtered out — backfill via
  // prisma/backfill-ai-asset-suggestion-tenant.sql closes most of the
  // gap; orphans without assetId are unrecoverable and stay hidden.
  const tenant = await getCurrentTenant();
  const rows = await prisma.aiAssetSuggestion.findMany({
    where: tenant ? { tenantId: tenant.id } : { id: "__none__" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      kind: true,
      inputText: true,
      outputJson: true,
      modelName: true,
      promptTokens: true,
      completionTokens: true,
      latencyMs: true,
      createdAt: true,
    },
  });

  // Roll-up stats. Cheap to compute over 100 rows; if this gets slow
  // we'll move to a SQL aggregate.
  const totalRuns = rows.length;
  const totalPromptTokens = rows.reduce((a, r) => a + (r.promptTokens ?? 0), 0);
  const totalCompletionTokens = rows.reduce(
    (a, r) => a + (r.completionTokens ?? 0),
    0
  );
  const cacheReadTokens = rows.reduce((a, r) => {
    const cached = (r.outputJson as { cacheReadTokens?: number | null })
      ?.cacheReadTokens;
    return a + (cached ?? 0);
  }, 0);
  const cacheHits = rows.filter((r) => {
    const cached = (r.outputJson as { cacheReadTokens?: number | null })
      ?.cacheReadTokens;
    return (cached ?? 0) > 0;
  }).length;
  // Decision tracking — proves human-in-the-loop discipline is real.
  // Different kinds use different decision verbs:
  //   CAPEX_CLASSIFICATION:  ACCEPTED / REJECTED
  //   USEFUL_LIFE:           ACCEPTED / REJECTED (v0.6+ will actually apply)
  //   IMPAIRMENT_INDICATOR:  FLAGGED / DISMISSED
  // "decided" = terminal state of any kind; "positive" = the verb that
  // means "act on this" (ACCEPTED / FLAGGED).
  const TERMINAL = new Set(["ACCEPTED", "REJECTED", "FLAGGED", "DISMISSED"]);
  const POSITIVE = new Set(["ACCEPTED", "FLAGGED"]);
  const decided = rows.filter((r) => {
    const d = (r.outputJson as { decision?: string })?.decision;
    return d != null && TERMINAL.has(d);
  }).length;
  const accepted = rows.filter((r) => {
    const d = (r.outputJson as { decision?: string })?.decision;
    return d != null && POSITIVE.has(d);
  }).length;

  // Crude cost: Opus 4.7 prices — $5/M input, $25/M output. Cache reads
  // are billed at ~10% of input. Display in cents at high precision so
  // the audit looks honest.
  const inputCost =
    ((totalPromptTokens - cacheReadTokens) * 5 + cacheReadTokens * 0.5) /
    1_000_000;
  const outputCost = (totalCompletionTokens * 25) / 1_000_000;
  const totalCost = inputCost + outputCost;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">AI audit log</h1>
        <p className="text-sm text-ink-500">
          Every AI suggestion fa-amort has run, regardless of whether a human
          accepted it. The substrate's trust model is "AI proposes; humans
          approve; ledger-core posts" — this page is the record that proves
          the human stayed in the loop.
        </p>
      </header>

      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total runs" value={totalRuns.toLocaleString()} />
        <StatCard
          label="Action rate"
          value={
            decided > 0
              ? `${((accepted / decided) * 100).toFixed(0)}%`
              : "—"
          }
          hint={`${accepted} accepted/flagged of ${decided} decided · ${totalRuns - decided} pending`}
        />
        <StatCard
          label="Cache hit rate"
          value={
            totalRuns > 0
              ? `${((cacheHits / totalRuns) * 100).toFixed(0)}%`
              : "—"
          }
          hint={`${cacheHits} of ${totalRuns}`}
        />
        <StatCard
          label="Tokens used"
          value={(totalPromptTokens + totalCompletionTokens).toLocaleString()}
          hint={`${totalPromptTokens.toLocaleString()} in / ${totalCompletionTokens.toLocaleString()} out`}
        />
        <StatCard
          label="Estimated cost"
          value={
            totalCost > 0
              ? `$${totalCost.toFixed(4)}`
              : "$0.00"
          }
          hint="Opus 4.7 retail pricing"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {rows.length} suggestion{rows.length === 1 ? "" : "s"}
          </CardTitle>
          <span className="text-xs text-ink-500">
            Newest first · capped at 100
          </span>
        </CardHeader>
        <CardContent className={rows.length === 0 ? "" : "p-0"}>
          {rows.length === 0 ? (
            <EmptyState
              title="No AI suggestions yet"
              description="Try a classification at /ai-capex, a useful-life reassessment at /ai-useful-life, or an impairment screening at /ai-impairment."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Kind</TH>
                  <TH>Input</TH>
                  <TH>AI proposal</TH>
                  <TH>Human decision</TH>
                  <TH>Confidence</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Latency</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const view = projectRow(r);
                  const total =
                    (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
                  return (
                    <TR key={r.id}>
                      <TD className="text-xs text-ink-500">
                        {r.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                      </TD>
                      <TD>
                        <Badge tone="info">{r.kind}</Badge>
                      </TD>
                      <TD className="max-w-xs">
                        <div className="text-xs text-ink-800 line-clamp-2">
                          {r.inputText}
                        </div>
                      </TD>
                      <TD>{view.proposalBadge}</TD>
                      <TD>{view.decisionBadge}</TD>
                      <TD className="text-xs text-ink-700">
                        {view.confidence != null
                          ? `${(view.confidence * 100).toFixed(0)}%`
                          : "—"}
                      </TD>
                      <TD className="text-right text-xs text-ink-700 font-mono">
                        {total.toLocaleString()}
                      </TD>
                      <TD className="text-right text-xs text-ink-700 font-mono">
                        {r.latencyMs ? `${r.latencyMs}ms` : "—"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-3">
      <div className="text-xs text-ink-500 uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink-900">{value}</div>
      {hint ? <div className="text-xs text-ink-400 mt-0.5">{hint}</div> : null}
    </div>
  );
}

// projectRow normalizes each suggestion kind's outputJson into the
// shape the table renders: a proposal badge (what the AI said), a
// decision badge (what the human did), and a confidence value.
// Kinds use different verbs (CAPITALIZE/EXPENSE vs EXTEND/KEEP/SHORTEN
// vs N indicators), so this is where the kind-specific logic lives.
type AuditRow = {
  id: string;
  kind: string;
  inputText: string;
  outputJson: unknown;
};

interface RowView {
  proposalBadge: React.ReactNode;
  decisionBadge: React.ReactNode;
  confidence: number | null;
}

function projectRow(r: AuditRow): RowView {
  const out = r.outputJson as Record<string, unknown>;
  const rawDecision = (out?.decision as string) ?? "PENDING";

  if (r.kind === "CAPEX_CLASSIFICATION") {
    const c = out?.classification as
      | {
          capitalize: boolean;
          category: string | null;
          confidence: number;
        }
      | undefined;
    const createdAssetCode = (out?.createdAssetCode as string) ?? null;
    return {
      proposalBadge: c ? (
        c.capitalize ? (
          <Badge tone="positive">CAPITALIZE</Badge>
        ) : (
          <Badge tone="warning">EXPENSE</Badge>
        )
      ) : (
        <span className="text-ink-400">—</span>
      ),
      decisionBadge:
        rawDecision === "ACCEPTED" ? (
          <span className="flex flex-col items-start gap-0.5">
            <Badge tone="positive">✓ Accepted</Badge>
            {createdAssetCode ? (
              <span className="text-[10px] text-ink-500 font-mono">
                {createdAssetCode}
              </span>
            ) : null}
          </span>
        ) : rawDecision === "REJECTED" ? (
          <Badge tone="negative">✗ Rejected</Badge>
        ) : (
          <Badge tone="neutral">pending</Badge>
        ),
      confidence: c?.confidence ?? null,
    };
  }

  if (r.kind === "USEFUL_LIFE") {
    const rec = out?.recommendation as
      | {
          changeKind: "KEEP" | "EXTEND" | "SHORTEN";
          recommendedUsefulLifeMonths: number;
          delta: number;
          confidence: number;
        }
      | undefined;
    return {
      proposalBadge: rec ? (
        rec.changeKind === "EXTEND" ? (
          <span className="flex flex-col items-start gap-0.5">
            <Badge tone="positive">EXTEND</Badge>
            <span className="text-[10px] text-ink-500 font-mono">
              {rec.recommendedUsefulLifeMonths}mo (+{rec.delta})
            </span>
          </span>
        ) : rec.changeKind === "SHORTEN" ? (
          <span className="flex flex-col items-start gap-0.5">
            <Badge tone="warning">SHORTEN</Badge>
            <span className="text-[10px] text-ink-500 font-mono">
              {rec.recommendedUsefulLifeMonths}mo ({rec.delta})
            </span>
          </span>
        ) : (
          <Badge tone="neutral">KEEP</Badge>
        )
      ) : (
        <span className="text-ink-400">—</span>
      ),
      decisionBadge:
        rawDecision === "ACCEPTED" ? (
          <Badge tone="positive">✓ Accepted</Badge>
        ) : rawDecision === "REJECTED" ? (
          <Badge tone="negative">✗ Rejected</Badge>
        ) : (
          <Badge tone="neutral">pending</Badge>
        ),
      confidence: rec?.confidence ?? null,
    };
  }

  if (r.kind === "IMPAIRMENT_INDICATOR") {
    const resp = out?.response as
      | {
          hasImpairmentIndicators: boolean;
          overallSeverity: "NONE" | "LOW" | "MEDIUM" | "HIGH";
          indicators: Array<{ affectedCategory: string }>;
        }
      | undefined;
    const sev = resp?.overallSeverity ?? "NONE";
    return {
      proposalBadge: resp ? (
        resp.hasImpairmentIndicators ? (
          <span className="flex flex-col items-start gap-0.5">
            <Badge
              tone={
                sev === "HIGH"
                  ? "negative"
                  : sev === "MEDIUM"
                    ? "warning"
                    : "neutral"
              }
            >
              {sev} ({resp.indicators.length})
            </Badge>
          </span>
        ) : (
          <Badge tone="positive">NONE</Badge>
        )
      ) : (
        <span className="text-ink-400">—</span>
      ),
      decisionBadge:
        rawDecision === "FLAGGED" ? (
          <Badge tone="warning">⚑ Flagged</Badge>
        ) : rawDecision === "DISMISSED" ? (
          <Badge tone="neutral">Dismissed</Badge>
        ) : (
          <Badge tone="neutral">pending</Badge>
        ),
      // Severity → confidence-proxy so the column has a value to show.
      // Higher severity = higher "screening confidence the asset class needs
      // attention." (HIGH≈1.0, MEDIUM≈0.7, LOW≈0.4, NONE≈null)
      confidence:
        sev === "HIGH"
          ? 1.0
          : sev === "MEDIUM"
            ? 0.7
            : sev === "LOW"
              ? 0.4
              : null,
    };
  }

  // Fallback for any new kinds we forgot to handle.
  return {
    proposalBadge: <span className="text-ink-400">—</span>,
    decisionBadge: <Badge tone="neutral">{rawDecision.toLowerCase()}</Badge>,
    confidence: null,
  };
}
