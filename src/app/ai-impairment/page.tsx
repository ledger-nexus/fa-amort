// AI impairment-indicator screener page.
//
// Paste text — internal memo, news article, vendor announcement,
// regulatory update — and Claude flags which of your fixed-asset
// categories might warrant a formal ASC 360-10 recoverability test
// this quarter.
//
// Output is a screening signal, not a determination. The actual
// impairment test (carrying value vs undiscounted cash flows, fair
// value measurement, write-down JE) is OFF-SYSTEM workpaper work
// the CPA does after this surface flags a category.
//
// Decision states for this kind:
//   PENDING   — just classified, no human review yet
//   FLAGGED   — CPA confirmed worth a deeper look (escalated to workpapers)
//   DISMISSED — CPA reviewed and decided no follow-up needed
//
// No "ACCEPTED & posted" — impairment recognition needs a manual JE.

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IMPAIRMENT_MODEL } from "@/lib/ai/impairment-classifier";
import { ImpairmentForm } from "./form";

export default async function AiImpairmentPage() {
  const recent = await prisma.aiAssetSuggestion.findMany({
    where: { kind: "IMPAIRMENT_INDICATOR" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      inputText: true,
      outputJson: true,
      createdAt: true,
      promptTokens: true,
      completionTokens: true,
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">
          AI impairment-indicator screener
        </h1>
        <p className="text-sm text-ink-500">
          Paste a news article, internal memo, vendor announcement, or
          regulatory update. Claude flags whether any of your fixed-asset
          categories might warrant a formal ASC 360-10 recoverability test
          this quarter. This is a <strong>screening tool</strong> — the
          actual impairment test (carrying value vs undiscounted cash flow,
          fair value measurement, write-down JE) is off-system workpaper
          work a CPA does after a flag.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Powered by <span className="font-mono">{IMPAIRMENT_MODEL}</span> ·
          Persists to{" "}
          <code className="font-mono text-xs">AiAssetSuggestion</code> with{" "}
          <code className="font-mono text-xs">kind=IMPAIRMENT_INDICATOR</code>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Screen a source</CardTitle>
          <span className="text-xs text-ink-500">
            Paste enough context for the model to reason about which categories
            are affected. Optional source label appears in the audit log.
          </span>
        </CardHeader>
        <CardContent>
          <ImpairmentForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent screenings</CardTitle>
          <span className="text-xs text-ink-500">
            5 most recent · full history at{" "}
            <a href="/ai-audit" className="text-accent-600 hover:underline">
              /ai-audit
            </a>
          </span>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-ink-500">
              No screenings yet — paste a source above to run one.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {recent.map((r) => {
                const out = r.outputJson as {
                  response?: {
                    hasImpairmentIndicators: boolean;
                    overallSeverity: "NONE" | "LOW" | "MEDIUM" | "HIGH";
                    indicators: Array<{ affectedCategory: string }>;
                  };
                  decision?: "PENDING" | "FLAGGED" | "DISMISSED";
                };
                const resp = out.response;
                const decision = out.decision ?? "PENDING";
                return (
                  <li
                    key={r.id}
                    className="border-b border-ink-100 pb-2 last:border-b-0"
                  >
                    <div className="text-xs text-ink-500">
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")} ·{" "}
                      {(r.promptTokens ?? 0) + (r.completionTokens ?? 0)} tokens ·{" "}
                      <span
                        className={
                          decision === "FLAGGED"
                            ? "text-amber-700 font-medium"
                            : decision === "DISMISSED"
                              ? "text-ink-500"
                              : "text-ink-400"
                        }
                      >
                        {decision.toLowerCase()}
                      </span>
                    </div>
                    <div className="text-sm text-ink-800 line-clamp-2 mt-0.5">
                      {r.inputText.split("\n")[0]}
                    </div>
                    {resp ? (
                      <div className="text-xs mt-1">
                        <span
                          className={
                            resp.overallSeverity === "HIGH"
                              ? "text-red-700 font-medium"
                              : resp.overallSeverity === "MEDIUM"
                                ? "text-amber-700 font-medium"
                                : resp.overallSeverity === "LOW"
                                  ? "text-ink-600 font-medium"
                                  : "text-emerald-700 font-medium"
                          }
                        >
                          {resp.overallSeverity}
                        </span>
                        <span className="text-ink-500">
                          {" · "}
                          {resp.indicators.length} indicator
                          {resp.indicators.length === 1 ? "" : "s"}
                          {resp.indicators.length > 0
                            ? ` (${Array.from(
                                new Set(resp.indicators.map((i) => i.affectedCategory))
                              ).join(", ")})`
                            : ""}
                        </span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
