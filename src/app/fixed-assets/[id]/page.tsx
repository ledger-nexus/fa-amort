// Asset detail. Shows acquisition metadata, per-book attributes
// (depreciation method, useful life, accum dep, last-run date) with
// a "Run depreciation" form per book, plus the forward-looking schedule
// projection for context.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, formatMonth } from "@/lib/utils/format";
import { projectFullSchedule } from "@/lib/accounting/depreciation";
import { RunDepreciationForm } from "./run-depreciation-form";
import { DisposeForm } from "./dispose-form";
import { ImpairForm } from "./impair-form";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function FixedAssetDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { suggestionId?: string };
}) {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the read.
  // Without this, a signed-in user could navigate to /fixed-assets/[any-id]
  // and see cost, vendor, per-book accumulated depreciation, and the
  // full forward schedule of another tenant's asset.
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();
  const asset = await prisma.fixedAsset.findFirst({
    where: { id: params.id, entity: { tenantId: tenant.id } },
    include: {
      entity: { select: { code: true, name: true } },
      vendor: { select: { code: true, displayName: true } },
      bookAttributes: {
        orderBy: { book: { code: "asc" } },
        include: { book: { select: { id: true, code: true, name: true } } },
      },
    },
  });
  if (!asset) notFound();

  const cost = new Decimal(asset.acquisitionCost.toString());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/fixed-assets"
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          ← All fixed assets
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900 font-mono">{asset.code}</h2>
        <p className="text-sm text-ink-500">{asset.description}</p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
          <Field label="Entity" value={`${asset.entity.code} — ${asset.entity.name}`} />
          <Field label="Category" value={asset.category ?? "—"} />
          <Field label="Vendor" value={asset.vendor?.displayName ?? "—"} />
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Status
            </div>
            <div className="mt-1">
              <Badge
                tone={
                  asset.status === "IN_SERVICE"
                    ? "positive"
                    : asset.status === "DISPOSED"
                      ? "neutral"
                      : "warning"
                }
              >
                {asset.status}
              </Badge>
            </div>
          </div>
          <Field label="Acquired" value={formatDate(asset.acquisitionDate)} />
          <Field
            label="Cost"
            value={formatMoney(asset.acquisitionCost.toString())}
            mono
          />
          <Field label="Asset account" value={asset.assetAccountCode} />
          <Field label="Currency" value={asset.acquisitionCurrencyId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-book depreciation attributes</CardTitle>
          <span className="text-xs text-ink-500">
            One row per book the asset is depreciated in. Run a book's depreciation through any month-end
            using its form on the right — the engine posts one JE per missing calendar month via the
            ledger-core HTTP bridge.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {asset.bookAttributes.length === 0 ? (
            <div className="px-5 py-4 text-sm text-ink-500">
              No book attributes configured. ledger-core's setupFixedAssets()
              normally creates these at seed time.
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Book</TH>
                  <TH>Method</TH>
                  <TH>Life</TH>
                  <TH>In service</TH>
                  <TH className="text-right">Salvage</TH>
                  <TH className="text-right">Accum.</TH>
                  <TH className="text-right">NBV</TH>
                  <TH>Last run</TH>
                  <TH>Action</TH>
                </tr>
              </THead>
              <TBody>
                {asset.bookAttributes.map((b) => {
                  const accum = new Decimal(b.accumulatedDepreciation.toString());
                  const nbv = cost.minus(accum);
                  return (
                    <TR key={b.bookId}>
                      <TD className="font-mono text-xs">{b.book.code}</TD>
                      <TD className="text-xs">
                        <Badge tone="info">{b.depreciationMethod}</Badge>
                      </TD>
                      <TD className="text-xs text-ink-700">{b.usefulLifeMonths} mo</TD>
                      <TD className="text-xs text-ink-500">
                        {formatDate(b.inServiceDate)}
                      </TD>
                      <TD className="amount-cell text-right text-ink-600">
                        {formatMoney(b.salvageValue.toString())}
                      </TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(accum)}
                      </TD>
                      <TD className="amount-cell text-right font-semibold text-ink-900">
                        {formatMoney(nbv)}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {b.lastDepreciatedThrough
                          ? formatDate(b.lastDepreciatedThrough)
                          : "never"}
                      </TD>
                      <TD>
                        {asset.status === "DISPOSED" ? (
                          <span className="text-[11px] text-ink-400">disposed</span>
                        ) : (
                          <RunDepreciationForm
                            assetId={asset.id}
                            bookId={b.bookId}
                            bookCode={b.book.code}
                          />
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Disposal + impairment flows. Hidden once the asset is
          DISPOSED. The two forms are siblings — dispose closes the
          asset entirely; impair writes down NBV but keeps the asset
          IN_SERVICE. */}
      {asset.status !== "DISPOSED" && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <DisposeForm
              assetId={asset.id}
              assetCode={asset.code}
              todayIso={new Date().toISOString().slice(0, 10)}
            />
          </div>
          <div className="flex-1">
            <ImpairForm
              assetId={asset.id}
              assetCode={asset.code}
              todayIso={new Date().toISOString().slice(0, 10)}
              sourceSuggestionId={searchParams.suggestionId}
              books={asset.bookAttributes.map((b) => ({
                bookCode: b.book.code,
                nbv: new Decimal(asset.acquisitionCost.toString())
                  .minus(new Decimal(b.accumulatedDepreciation.toString()))
                  .toFixed(2),
              }))}
            />
          </div>
        </div>
      )}
      {asset.status === "DISPOSED" && (
        <div className="rounded-md border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600">
          This asset was disposed
          {asset.disposalDate
            ? ` on ${formatDate(asset.disposalDate)}`
            : ""}
          . Disposal proceeds:{" "}
          {asset.disposalProceeds
            ? `$${asset.disposalProceeds.toString()}`
            : "(none)"}
          .
        </div>
      )}

      {asset.bookAttributes.map((b) => {
        const schedule = projectFullSchedule({
          cost: new Decimal(asset.acquisitionCost.toString()),
          salvageValue: new Decimal(b.salvageValue.toString()),
          usefulLifeMonths: b.usefulLifeMonths,
          inServiceDate: b.inServiceDate,
          depreciationMethod: b.depreciationMethod as
            | "STRAIGHT_LINE"
            | "DOUBLE_DECLINING"
            | "MACRS_3_HY"
            | "MACRS_5_HY"
            | "MACRS_7_HY"
            | "MACRS_15_HY"
            | "UNITS_OF_PRODUCTION"
            | "NONE",
        });
        if (schedule.length === 0) return null;
        const cap = 14; // first 12 months + first 2 of year 2
        const previewed = schedule.slice(0, cap);
        return (
          <Card key={b.bookId}>
            <CardHeader>
              <CardTitle>
                Forward schedule — <span className="font-mono">{b.book.code}</span>
              </CardTitle>
              <span className="text-xs text-ink-500">
                Projection if the asset depreciates undisturbed from in-service.
                Shows first {previewed.length} of {schedule.length} total periods.
              </span>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead>
                  <tr>
                    <TH>Month</TH>
                    <TH className="text-right">Expense</TH>
                    <TH className="text-right">Cumulative</TH>
                    <TH className="text-right">NBV</TH>
                  </tr>
                </THead>
                <TBody>
                  {previewed.map((p, i) => (
                    <TR key={i}>
                      <TD className="text-xs text-ink-700">{formatMonth(p.periodStart)}</TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(p.expenseAmount)}
                      </TD>
                      <TD className="amount-cell text-right text-ink-600">
                        {formatMoney(p.cumulativeAfter)}
                      </TD>
                      <TD className="amount-cell text-right text-ink-900">
                        {formatMoney(p.netBookValueAfter)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div className={`mt-0.5 text-sm text-ink-800 ${mono ? "amount-cell" : ""}`}>{value}</div>
    </div>
  );
}
