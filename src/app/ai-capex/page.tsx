// AI capex classifier page.
//
// Paste a purchase description, hit Classify, see the structured
// proposal. The Server Action persists every call to AiAssetSuggestion
// so the audit log at /ai-audit captures the run regardless of whether
// the human accepts.
//
// v0.2 surface: read-only proposal display. v0.3 will add the
// "Accept & create FixedAsset" button that turns an accepted
// suggestion into a real fixed asset via createFixedAsset.

import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CAPEX_CLASSIFIER_MODEL } from "@/lib/ai/capex-classifier";
import { ClassifierForm } from "./classifier-form";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function AiCapexPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the "recent
  // classifications" panel via the linked asset's entity. CAPEX rows
  // whose assetId is still null (i.e., pending review — they ran
  // BEFORE the asset existed) are filtered out, because the schema
  // has no tenantId column on AiAssetSuggestion yet. That's a known
  // gap; the schema TODO is to add tenantId so we can attribute
  // unlinked rows too. For now, recent shows only accepted-into-this-
  // tenant classifications.
  const tenant = await getCurrentTenant();
  const recent = await prisma.aiAssetSuggestion.findMany({
    where: tenant
      ? {
          kind: "CAPEX_CLASSIFICATION",
          asset: { entity: { tenantId: tenant.id } },
        }
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
        <h1 className="text-xl font-semibold text-ink-900">AI capex classifier</h1>
        <p className="text-sm text-ink-500">
          Paste a purchase description (AP invoice line, vendor quote, receipt
          OCR text). Claude returns a structured recommendation: capitalize or
          expense, asset category, useful life, salvage, and GL account
          suggestions. A CPA reviews before any FixedAsset is created.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Powered by <span className="font-mono">{CAPEX_CLASSIFIER_MODEL}</span> ·
          Every classification persists to{" "}
          <code className="font-mono text-xs">AiAssetSuggestion</code> for audit.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Classify a purchase</CardTitle>
          <span className="text-xs text-ink-500">
            Enough detail to disambiguate: vendor, item description, dollar
            amount, term if applicable. More context = higher confidence.
          </span>
        </CardHeader>
        <CardContent>
          <ClassifierForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent classifications</CardTitle>
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
              No classifications yet — run one above.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {recent.map((r) => {
                const c = (r.outputJson as { classification?: Classification })
                  .classification;
                return (
                  <li key={r.id} className="border-b border-ink-100 pb-2 last:border-b-0">
                    <div className="text-xs text-ink-500">
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")} ·{" "}
                      {(r.promptTokens ?? 0) + (r.completionTokens ?? 0)} tokens
                    </div>
                    <div className="text-sm text-ink-800 line-clamp-2 mt-0.5">
                      {r.inputText}
                    </div>
                    {c ? (
                      <div className="text-xs mt-1">
                        <span
                          className={
                            c.capitalize
                              ? "text-emerald-700 font-medium"
                              : "text-amber-700 font-medium"
                          }
                        >
                          {c.capitalize ? "CAPITALIZE" : "EXPENSE"}
                        </span>
                        {c.capitalize ? (
                          <span className="text-ink-600">
                            {" · "}
                            <span className="font-mono">{c.category}</span> ·{" "}
                            {c.usefulLifeMonths}mo
                          </span>
                        ) : null}
                        <span className="text-ink-500">
                          {" · "}confidence{" "}
                          {(c.confidence * 100).toFixed(0)}%
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

// Local copy of the Classification shape from the classifier module —
// only used for display. Importing the full module here would pull in
// the SDK at server-component build time which is fine but noisier.
type Classification = {
  capitalize: boolean;
  category: string | null;
  usefulLifeMonths: number | null;
  confidence: number;
};
