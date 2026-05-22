// All fixed assets — full table with per-row book attributes preview
// and a link to the detail page where depreciation can be run.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

export default async function FixedAssetsListPage() {
  const assets = await prisma.fixedAsset.findMany({
    orderBy: [{ entity: { code: "asc" } }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      description: true,
      category: true,
      status: true,
      acquisitionDate: true,
      acquisitionCost: true,
      entity: { select: { code: true } },
      bookAttributes: {
        select: {
          accumulatedDepreciation: true,
          lastDepreciatedThrough: true,
          depreciationMethod: true,
          book: { select: { code: true } },
        },
      },
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">All fixed assets</h1>
        <p className="text-sm text-ink-500">
          {assets.length} asset{assets.length === 1 ? "" : "s"} across all entities. Click a row to run depreciation.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Assets</CardTitle>
        </CardHeader>
        <CardContent className={assets.length === 0 ? "" : "p-0"}>
          {assets.length === 0 ? (
            <EmptyState
              title="No fixed assets seeded"
              description="Run ledger-core's seed (pnpm db:seed) to create the Northwind sample asset."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Description</TH>
                  <TH>Entity</TH>
                  <TH>Category</TH>
                  <TH>Acquired</TH>
                  <TH className="text-right">Cost</TH>
                  <TH className="text-right">Accum. (max)</TH>
                  <TH>Books</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {assets.map((a) => {
                  // Max accumulated across books is a useful single-number
                  // summary — typically the tax book's accum will be
                  // highest under MACRS / bonus depreciation.
                  const maxAccum = a.bookAttributes.reduce(
                    (acc, b) => {
                      const v = new Decimal(b.accumulatedDepreciation.toString());
                      return v.greaterThan(acc) ? v : acc;
                    },
                    new Decimal(0)
                  );
                  return (
                    <TR key={a.id}>
                      <TD className="font-mono text-xs text-ink-700">
                        <Link
                          href={`/fixed-assets/${a.id}`}
                          className="hover:underline"
                        >
                          {a.code}
                        </Link>
                      </TD>
                      <TD className="text-ink-900">{a.description}</TD>
                      <TD className="font-mono text-xs text-ink-600">
                        {a.entity.code}
                      </TD>
                      <TD className="text-xs text-ink-600">{a.category ?? "—"}</TD>
                      <TD className="text-xs text-ink-500">
                        {formatDate(a.acquisitionDate)}
                      </TD>
                      <TD className="amount-cell text-right">
                        {formatMoney(a.acquisitionCost.toString())}
                      </TD>
                      <TD className="amount-cell text-right text-ink-600">
                        {formatMoney(maxAccum)}
                      </TD>
                      <TD className="flex flex-wrap gap-1 text-[10px]">
                        {a.bookAttributes.map((b) => (
                          <Badge key={b.book.code} tone="info">
                            {b.book.code}
                          </Badge>
                        ))}
                      </TD>
                      <TD>
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
