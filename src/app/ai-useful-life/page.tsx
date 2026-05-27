// AI useful-life reassessment page.
//
// Two use modes:
//   - Standalone: fill in the form (asset facts) and get a recommendation
//   - Asset-attached (v0.6): from a FixedAsset detail page, a "Reassess
//     useful life" button pre-fills this form with that asset's current
//     attributes. Not wired yet.
//
// The standalone surface is what v0.5 ships. CPAs use it to think
// through "should we extend the laptop fleet?" without needing to
// commit to an asset row first.

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { USEFUL_LIFE_MODEL } from "@/lib/ai/useful-life-classifier";
import { UsefulLifeForm } from "./form";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function AiUsefulLifePage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope via the tenantId
  // column. Standalone reassessments (assetId null) now show up for
  // their owning tenant — the previous join was filtering them out.
  const tenant = await getCurrentTenant();
  const recent = await prisma.aiAssetSuggestion.findMany({
    where: tenant
      ? { kind: "USEFUL_LIFE", tenantId: tenant.id }
      : { id: "__none__" },
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
          AI useful-life reassessment
        </h1>
        <p className="text-sm text-ink-500">
          Reconsider an existing asset&apos;s useful life. Common triggers: routine
          mid-life review, vendor end-of-life announcement, lease term change,
          physical damage, regulatory update. Per ASC 250-10-45-17, accepted
          changes are applied PROSPECTIVELY — the remaining net book value
          depreciates over the new remaining useful life with no retrospective
          adjustment.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Powered by <span className="font-mono">{USEFUL_LIFE_MODEL}</span> ·
          Every reassessment persists to{" "}
          <code className="font-mono text-xs">AiAssetSuggestion</code> with{" "}
          <code className="font-mono text-xs">kind=USEFUL_LIFE</code>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Reassess an asset</CardTitle>
          <span className="text-xs text-ink-500">
            Provide the facts a CPA would consider: original useful life, how
            long it&apos;s been in service, any condition observations or
            external signals (EOL announcement, lease change, etc.).
          </span>
        </CardHeader>
        <CardContent>
          <UsefulLifeForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent reassessments</CardTitle>
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
              No reassessments yet — run one above.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {recent.map((r) => {
                const out = r.outputJson as {
                  recommendation?: {
                    recommendedUsefulLifeMonths: number;
                    delta: number;
                    changeKind: "KEEP" | "EXTEND" | "SHORTEN";
                    triggerType: string;
                    confidence: number;
                  };
                };
                const rec = out.recommendation;
                return (
                  <li
                    key={r.id}
                    className="border-b border-ink-100 pb-2 last:border-b-0"
                  >
                    <div className="text-xs text-ink-500">
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")} ·{" "}
                      {(r.promptTokens ?? 0) + (r.completionTokens ?? 0)} tokens
                    </div>
                    <div className="text-sm text-ink-800 line-clamp-2 mt-0.5">
                      {r.inputText.split("\n").slice(0, 2).join(" · ")}
                    </div>
                    {rec ? (
                      <div className="text-xs mt-1">
                        <span
                          className={
                            rec.changeKind === "EXTEND"
                              ? "text-emerald-700 font-medium"
                              : rec.changeKind === "SHORTEN"
                                ? "text-amber-700 font-medium"
                                : "text-ink-600 font-medium"
                          }
                        >
                          {rec.changeKind}
                        </span>
                        {" → "}
                        <span className="font-mono text-ink-700">
                          {rec.recommendedUsefulLifeMonths}mo
                          {rec.delta !== 0
                            ? ` (${rec.delta > 0 ? "+" : ""}${rec.delta})`
                            : ""}
                        </span>
                        <span className="text-ink-500">
                          {" · "}
                          <span className="font-mono">{rec.triggerType}</span> ·
                          confidence {(rec.confidence * 100).toFixed(0)}%
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
