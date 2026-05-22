// Depreciation runs — historical view of every JE we've posted through
// the ledger-core HTTP bridge. Queries JournalEntry rows where
// sourceSystem='fa-amort' and sourceRecordType='DepreciationRun'.
//
// One JE per (asset × book × month). The list shows newest first;
// click an entry to open the asset detail.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";

// Helper inline so we don't depend on revenue-rec's helper.
function formatRelativeTimeLocal(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toISOString().slice(0, 10);
}

export default async function DepreciationRunsPage() {
  const entries = await prisma.journalEntry.findMany({
    where: {
      sourceSystem: "fa-amort",
      sourceRecordType: "DepreciationRun",
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      entryNumber: true,
      memo: true,
      documentDate: true,
      createdAt: true,
      sourceRecordId: true,
      entity: { select: { code: true } },
      book: { select: { code: true } },
    },
  });

  // Parse sourceRecordId to extract (assetId, bookCode, periodEndDate).
  // Format from our Server Action: "<assetId>:<bookCode>:<YYYY-MM-DD>".
  function parseSourceRecord(id: string | null) {
    if (!id) return null;
    const parts = id.split(":");
    if (parts.length < 3) return null;
    return { assetId: parts[0], bookCode: parts[1], periodEnd: parts[2] };
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Depreciation runs</h1>
        <p className="text-sm text-ink-500">
          Every JE this engine has posted via the ledger-core HTTP bridge. One row per (asset × book × calendar month).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{entries.length} run{entries.length === 1 ? "" : "s"}</CardTitle>
          <span className="text-xs text-ink-500">
            Newest first · capped at 100 · click the asset link to see book state + run more periods
          </span>
        </CardHeader>
        <CardContent className={entries.length === 0 ? "" : "p-0"}>
          {entries.length === 0 ? (
            <EmptyState
              title="No depreciation runs yet"
              description="Open any fixed asset and click 'Run' next to a book to post the first depreciation JE."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Entry</TH>
                  <TH>Memo</TH>
                  <TH>Entity</TH>
                  <TH>Book</TH>
                  <TH>Period</TH>
                  <TH>Posted</TH>
                  <TH>Source</TH>
                </tr>
              </THead>
              <TBody>
                {entries.map((e) => {
                  const src = parseSourceRecord(e.sourceRecordId);
                  return (
                    <TR key={e.id}>
                      <TD className="font-mono text-xs text-ink-700">
                        {e.entryNumber}
                      </TD>
                      <TD className="text-ink-900 max-w-md truncate" title={e.memo}>
                        {e.memo}
                      </TD>
                      <TD className="font-mono text-xs text-ink-600">{e.entity.code}</TD>
                      <TD className="font-mono text-xs text-ink-600">{e.book.code}</TD>
                      <TD className="text-xs text-ink-500">
                        {formatDate(e.documentDate)}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {formatRelativeTimeLocal(e.createdAt)}
                      </TD>
                      <TD>
                        {src ? (
                          <Link
                            href={`/fixed-assets/${src.assetId}`}
                            className="text-[11px] text-accent-600 hover:underline"
                          >
                            asset →
                          </Link>
                        ) : (
                          <span className="text-[11px] text-ink-400">—</span>
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
    </div>
  );
}
