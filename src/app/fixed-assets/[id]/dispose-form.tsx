"use client";

// Dispose-asset form. Three-state: collapsed button → expanded form →
// result panel.
//
// The form is intentionally compact because most disposals only need
// the date + proceeds. Cash-account + gain/loss-account overrides are
// shown but default to the ledger-core conventions (1000 / 8100).

import { useState, useTransition } from "react";
import {
  disposeAssetAction,
  type DisposeAssetState,
} from "@/app/actions/dispose-asset";

interface Props {
  assetId: string;
  assetCode: string;
  /** ISO date string (YYYY-MM-DD) — pre-fills the date picker to today. */
  todayIso: string;
}

export function DisposeForm({ assetId, assetCode, todayIso }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [disposalDate, setDisposalDate] = useState(todayIso);
  const [proceeds, setProceeds] = useState("");
  const [cashAccount, setCashAccount] = useState("");
  const [gainLossAccount, setGainLossAccount] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DisposeAssetState | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !confirm(
        `Dispose ${assetCode} on ${disposalDate}? This catches up depreciation, posts the disposal JE per book, and marks the asset DISPOSED. Not easily reversible.`
      )
    )
      return;
    setResult(null);
    startTransition(async () => {
      const r = await disposeAssetAction({
        assetId,
        disposalDate,
        disposalProceeds: proceeds,
        proceedsCashAccountCode: cashAccount || undefined,
        gainLossAccountCode: gainLossAccount || undefined,
      });
      setResult(r);
      if (r.ok) {
        // Keep the panel open so the user sees the per-book breakdown,
        // but reset inputs so a second click doesn't accidentally retry.
        setProceeds("");
      }
    });
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="h-9 inline-flex items-center rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        Dispose asset…
      </button>
    );
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-red-900">
          Dispose {assetCode}
        </div>
        <button
          onClick={() => {
            setExpanded(false);
            setResult(null);
          }}
          className="text-xs text-red-700 hover:underline"
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <p className="mt-1 text-xs text-red-700">
        Catches up depreciation through the date below, posts a paired
        JE per book (Dr Cash, Dr Accum Dep, Cr Asset gross, Dr/Cr
        Gain/Loss), and marks the asset DISPOSED. Each book&rsquo;s gain
        or loss will differ because their accumulated depreciation
        balances differ.
      </p>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-red-900">
              Disposal date
            </label>
            <input
              type="date"
              required
              value={disposalDate}
              onChange={(e) => setDisposalDate(e.target.value)}
              max={todayIso}
              className="mt-1 w-full rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
              disabled={pending}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-red-900">
              Proceeds (USD)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={proceeds}
              onChange={(e) => setProceeds(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
              disabled={pending}
            />
            <p className="mt-0.5 text-[10px] text-red-600">
              Leave blank for scrapped or donated (no cash received).
            </p>
          </div>
        </div>
        <details className="text-xs text-red-700">
          <summary className="cursor-pointer">
            Override default accounts (advanced)
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-red-900">
                Cash account (default 1000)
              </label>
              <input
                type="text"
                value={cashAccount}
                onChange={(e) => setCashAccount(e.target.value)}
                placeholder="1000"
                className="mt-1 w-full rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs focus:border-red-500 focus:outline-none"
                disabled={pending}
              />
            </div>
            <div>
              <label className="text-xs text-red-900">
                Gain/loss account (default 8100)
              </label>
              <input
                type="text"
                value={gainLossAccount}
                onChange={(e) => setGainLossAccount(e.target.value)}
                placeholder="8100"
                className="mt-1 w-full rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs focus:border-red-500 focus:outline-none"
                disabled={pending}
              />
            </div>
          </div>
        </details>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="h-9 inline-flex items-center rounded-md bg-red-700 px-4 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {pending ? "Disposing..." : `Dispose ${assetCode}`}
          </button>
        </div>
      </form>

      {result && (
        <div
          className={`mt-3 rounded-md px-3 py-2 text-xs ${
            result.ok
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-100 text-red-900"
          }`}
        >
          <div>{result.message}</div>
          {result.ok && result.results && result.results.length > 0 && (
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-emerald-700">
                  <th className="text-left">Book</th>
                  <th className="text-left">Entry</th>
                  <th className="text-right">Proceeds</th>
                  <th className="text-right">NBV</th>
                  <th className="text-right">Gain / (Loss)</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.bookCode}>
                    <td className="font-mono">{r.bookCode}</td>
                    <td className="font-mono">{r.entryNumber}</td>
                    <td className="text-right tabular-nums">${r.proceeds}</td>
                    <td className="text-right tabular-nums">
                      ${r.nbvAtDisposal}
                    </td>
                    <td
                      className={`text-right tabular-nums font-medium ${
                        Number(r.gainLoss) >= 0
                          ? "text-emerald-700"
                          : "text-red-700"
                      }`}
                    >
                      ${r.gainLoss}
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
