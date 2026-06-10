"use client";

// Impairment form. Per-book amount inputs — the user enters $ to write
// down on each book (or leaves blank/0 to skip, typically for TAX).
//
// Each row shows current NBV so the user knows the ceiling. The form
// refuses amounts that exceed NBV on the client + server.

import { useState, useTransition } from "react";
import {
  impairAssetAction,
  type ImpairAssetState,
} from "@/app/actions/impair-asset";

export interface BookOption {
  bookCode: string;
  nbv: string; // "3,000.00" formatted; the action takes the raw input
}

interface Props {
  assetId: string;
  assetCode: string;
  todayIso: string;
  books: BookOption[];
  /** When the form was opened from a FLAGGED AI screening, pass its id. */
  sourceSuggestionId?: string;
}

export function ImpairForm({
  assetId,
  assetCode,
  todayIso,
  books,
  sourceSuggestionId,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState(todayIso);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ImpairAssetState | null>(null);

  function setAmount(bookCode: string, v: string) {
    setAmounts((prev) => ({ ...prev, [bookCode]: v }));
  }

  function handle(e: React.FormEvent) {
    e.preventDefault();
    const hasAny = Object.values(amounts).some(
      (v) => v && v.trim() !== "" && v.trim() !== "0"
    );
    if (!hasAny) {
      setResult({
        ok: false,
        message: "Enter an amount > 0 for at least one book.",
      });
      return;
    }
    if (
      !confirm(
        `Impair ${assetCode} on ${date}? This catches up depreciation per book, posts an impairment-loss JE per impaired book, and lowers NBV. The asset stays IN_SERVICE; subsequent depreciation runs from the new NBV. Not easily reversible.`
      )
    )
      return;
    setResult(null);
    startTransition(async () => {
      const r = await impairAssetAction({
        assetId,
        impairmentDate: date,
        amountByBook: amounts,
        sourceSuggestionId,
      });
      setResult(r);
      if (r.ok) setAmounts({});
    });
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="h-9 inline-flex items-center rounded-md border border-amber-300 bg-white px-4 text-sm font-medium text-amber-800 hover:bg-amber-50"
      >
        Measure impairment…
      </button>
    );
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-amber-900">
          Measure impairment — {assetCode}
        </div>
        <button
          onClick={() => {
            setExpanded(false);
            setResult(null);
          }}
          className="text-xs text-amber-700 hover:underline"
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <p className="mt-1 text-xs text-amber-700">
        ASC 360-10 Step 2: when carrying value exceeds undiscounted future
        cash flows, write down to fair value. Per-book amounts because
        impairment is typically GAAP-only — leave TAX blank or 0 to skip.
        Each impairment posts <code className="font-mono text-[10px]">Dr Impairment Loss / Cr Accum Dep</code> and lowers NBV without changing cost.
      </p>
      {sourceSuggestionId && (
        <p className="mt-1 text-[11px] text-amber-600">
          Linked to AI screening{" "}
          <code className="font-mono">
            {sourceSuggestionId.slice(0, 8)}…
          </code>{" "}
          — the screening will be stamped with the JE numbers on success.
        </p>
      )}

      <form onSubmit={handle} className="mt-3 flex flex-col gap-3">
        <div>
          <label className="text-xs font-medium text-amber-900">
            Impairment date
          </label>
          <input
            type="date"
            required
            value={date}
            max={todayIso}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm focus:border-amber-500 focus:outline-none"
            disabled={pending}
          />
        </div>
        <div>
          <div className="text-xs font-medium text-amber-900">
            Per-book loss amount
          </div>
          <p className="text-[11px] text-amber-700">
            Current NBV shown alongside the input as the ceiling. Leave a
            book blank or 0 to skip it.
          </p>
          <div className="mt-2 space-y-2">
            {books.map((b) => (
              <div key={b.bookCode} className="flex items-center gap-2">
                <div className="w-24 font-mono text-xs">{b.bookCode}</div>
                <div className="flex-1">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amounts[b.bookCode] ?? ""}
                    onChange={(e) => setAmount(b.bookCode, e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm focus:border-amber-500 focus:outline-none"
                    disabled={pending}
                  />
                </div>
                <div className="w-32 text-right text-[11px] text-amber-700">
                  NBV ${b.nbv}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="h-9 inline-flex items-center rounded-md bg-amber-700 px-4 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50"
          >
            {pending ? "Posting..." : `Impair ${assetCode}`}
          </button>
        </div>
      </form>

      {result && (
        <div
          className={`mt-3 rounded-md px-3 py-2 text-xs ${
            result.ok
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-50 text-red-900"
          }`}
        >
          <div>{result.message}</div>
          {result.ok && result.results && result.results.length > 0 && (
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-emerald-700">
                  <th className="text-left">Book</th>
                  <th className="text-left">Entry</th>
                  <th className="text-right">NBV before</th>
                  <th className="text-right">Loss</th>
                  <th className="text-right">NBV after</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.bookCode}>
                    <td className="font-mono">{r.bookCode}</td>
                    <td className="font-mono">{r.entryNumber}</td>
                    <td className="text-right tabular-nums">
                      ${r.nbvBeforeImpairment}
                    </td>
                    <td className="text-right tabular-nums font-medium text-red-700">
                      ${r.lossAmount}
                    </td>
                    <td className="text-right tabular-nums">
                      ${r.nbvAfterImpairment}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
