// Dashboard. Counts + the "what's not current" view — assets whose
// depreciation hasn't been run through the current period are flagged
// for the controller to action.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { getCurrentTenant } from "@/lib/auth/session";
import { getRepoAccess } from "@/lib/auth/repo-access";

export default async function DashboardPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the dashboard.
  // Without these filters, the "behind on depreciation" widget and
  // recent-assets list would surface every tenant's fixed-asset
  // metadata and accumulated depreciation balances.
  const tenant = await getCurrentTenant();
  // Plan gate: fa-amort is Growth+. Banner when not included.
  const access = tenant ? getRepoAccess(tenant) : null;
  const assetWhere = tenant
    ? { tenantId: tenant.id }
    : { id: "__none__" };
  const bookAttrWhere = tenant
    ? { asset: { tenantId: tenant.id } }
    : { assetId: "__none__" };
  const [assets, bookAttrs] = await Promise.all([
    prisma.fixedAsset.findMany({
      where: assetWhere,
      orderBy: { acquisitionDate: "desc" },
      take: 50,
      select: {
        id: true,
        code: true,
        description: true,
        category: true,
        status: true,
        acquisitionCost: true,
        acquisitionDate: true,
        entity: { select: { code: true } },
      },
    }),
    prisma.fixedAssetBookAttributes.findMany({
      where: bookAttrWhere,
      select: {
        assetId: true,
        bookId: true,
        accumulatedDepreciation: true,
        lastDepreciatedThrough: true,
        depreciationMethod: true,
        usefulLifeMonths: true,
        book: { select: { code: true } },
      },
    }),
  ]);

  const totalCost = assets.reduce(
    (acc, a) => acc.plus(new Decimal(a.acquisitionCost.toString())),
    new Decimal(0)
  );
  const inService = assets.filter((a) => a.status === "IN_SERVICE").length;
  const disposed = assets.filter((a) => a.status === "DISPOSED").length;

  // "Behind" = book attribute row whose lastDepreciatedThrough is null
  // OR more than 45 days ago. 45 because typical month-end is 30 days
  // ago but firms run depreciation a couple weeks after close.
  const fortyFiveDaysAgo = new Date();
  fortyFiveDaysAgo.setUTCDate(fortyFiveDaysAgo.getUTCDate() - 45);
  const behindRows = bookAttrs.filter(
    (b) =>
      !b.lastDepreciatedThrough ||
      b.lastDepreciatedThrough < fortyFiveDaysAgo
  );
  const totalAccum = bookAttrs.reduce(
    (acc, b) => acc.plus(new Decimal(b.accumulatedDepreciation.toString())),
    new Decimal(0)
  );

  return (
    <div className="flex flex-col gap-6">
      {access && !access.included && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm font-medium text-amber-900">
            fa-amort is not included in your &quot;{access.currentPlan}&quot; plan
          </div>
          <p className="mt-1 text-xs text-amber-700">
            Multi-book depreciation + AI capex / useful-life / impairment
            classifiers are part of the Growth and Scale tiers. Existing
            asset data stays visible, but new AI classifications and
            depreciation runs are refused (or warned in dev). Upgrade at{" "}
            <code className="font-mono">/admin/billing</code> in ledger-core.
          </p>
        </div>
      )}
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Fixed assets</h1>
        <p className="text-sm text-ink-500">
          Multi-book depreciation engine. Each asset has per-book attributes
          (different useful life / method / salvage per book) — runs post one
          JE per (asset × book × month) through the ledger-core HTTP bridge.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Total assets" value={String(assets.length)} />
        <Metric label="In service" value={String(inService)} />
        <Metric
          label="Σ acquisition cost"
          value={formatMoney(totalCost)}
          mono
        />
        <Metric
          label="Σ accum. depreciation"
          value={formatMoney(totalAccum)}
          mono
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Behind on depreciation</CardTitle>
          <span className="text-xs text-ink-500">
            Per-book attribute rows whose lastDepreciatedThrough is null or &gt; 45 days ago.
            Click an asset to run depreciation through this month.
          </span>
        </CardHeader>
        <CardContent className={behindRows.length === 0 ? "" : "p-0"}>
          {behindRows.length === 0 ? (
            <EmptyState
              title="Nothing behind"
              description="All in-service assets have current month-end depreciation booked."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {behindRows.slice(0, 15).map((b) => {
                const asset = assets.find((a) => a.id === b.assetId);
                if (!asset) return null;
                return (
                  <li key={`${b.assetId}-${b.bookId}`}>
                    <Link
                      href={`/fixed-assets/${b.assetId}`}
                      className="flex items-center justify-between px-5 py-3 hover:bg-ink-50"
                    >
                      <div>
                        <div className="text-sm font-medium text-ink-900">
                          {asset.code} — {asset.description}
                        </div>
                        <div className="text-[11px] text-ink-500">
                          <span className="font-mono">{b.book.code}</span> ·{" "}
                          <span className="font-mono">{b.depreciationMethod}</span> ·{" "}
                          last through{" "}
                          {b.lastDepreciatedThrough
                            ? formatDate(b.lastDepreciatedThrough)
                            : "never"}
                        </div>
                      </div>
                      <Badge tone="warning">behind</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent assets</CardTitle>
        </CardHeader>
        <CardContent className={assets.length === 0 ? "" : "p-0"}>
          {assets.length === 0 ? (
            <EmptyState
              title="No fixed assets seeded"
              description="Run ledger-core's seed (pnpm db:seed) to create the Northwind sample asset."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {assets.slice(0, 10).map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/fixed-assets/${a.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-ink-50"
                  >
                    <div>
                      <div className="text-sm font-medium text-ink-900">
                        <span className="font-mono">{a.code}</span> — {a.description}
                      </div>
                      <div className="text-[11px] text-ink-500">
                        {a.entity.code} · {a.category ?? "—"} · acquired{" "}
                        {formatDate(a.acquisitionDate)}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="amount-cell text-sm text-ink-700">
                        {formatMoney(a.acquisitionCost.toString())}
                      </span>
                      <Badge
                        tone={
                          a.status === "IN_SERVICE"
                            ? "positive"
                            : a.status === "DISPOSED"
                              ? "neutral"
                              : "warning"
                        }
                      >
                        {a.status}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div
          className={`mt-1 text-lg font-semibold text-ink-900 ${mono ? "amount-cell" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
