"use client";

// Inline "Run depreciation through <date>" control for one book attribute
// row. Calls runDepreciationAction. Defaults the through-date to the
// last day of the previous calendar month — the typical month-end target.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { runDepreciationAction } from "@/app/actions/run-depreciation";

interface Props {
  assetId: string;
  bookId: string;
  bookCode: string;
}

/** Last day of the previous calendar month, YYYY-MM-DD (UTC). */
function defaultThroughDate(): string {
  const d = new Date();
  const lastDayPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return lastDayPrev.toISOString().slice(0, 10);
}

export function RunDepreciationForm({ assetId, bookId, bookCode }: Props) {
  const [pending, startTransition] = useTransition();
  const [throughDate, setThroughDate] = useState<string>(defaultThroughDate());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await runDepreciationAction({ assetId, bookId, throughDate });
      if (!result.ok) {
        setError(result.message ?? "Run failed");
      } else {
        setMessage(
          result.periodsBooked === 0
            ? result.message ?? "Already current."
            : `Booked ${result.periodsBooked} period(s) totaling ${result.totalExpense}. Entries: ${(result.entryNumbers ?? []).join(", ")}.`
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-ink-200 bg-ink-50/30 px-3 py-2">
      <div className="text-[11px] font-medium text-ink-700">
        Run for <span className="font-mono">{bookCode}</span>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-ink-500">Through:</label>
        <input
          type="date"
          value={throughDate}
          onChange={(e) => setThroughDate(e.target.value)}
          disabled={pending}
          className="h-7 rounded border border-ink-200 bg-white px-2 text-xs"
        />
        <Button size="sm" onClick={onSubmit} disabled={pending}>
          {pending ? "Running…" : "Run"}
        </Button>
      </div>
      {message && <div className="text-[11px] text-positive">{message}</div>}
      {error && <div className="text-[11px] text-negative">{error}</div>}
    </div>
  );
}
