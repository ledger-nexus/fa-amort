"use client";

// Client Component: useful-life reassessment form + result card.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  classifyUsefulLifeAction,
  type ClassifyUsefulLifeState,
} from "@/app/actions/classify-useful-life";

const SAMPLES = [
  {
    label: "Routine review (KEEP)",
    fill: {
      description: "8 MacBook Pros for engineering team",
      category: "COMPUTER_EQUIPMENT",
      originalUsefulLifeMonths: 36,
      monthsInService: 18,
      conditionNotes: "All units in active use; no failures.",
      externalSignals: "",
    },
  },
  {
    label: "Vendor EOL (SHORTEN)",
    fill: {
      description: "Cisco Catalyst 9300 switches",
      category: "COMPUTER_EQUIPMENT",
      originalUsefulLifeMonths: 60,
      monthsInService: 36,
      conditionNotes: "All units operating normally.",
      externalSignals:
        "Cisco announced end-of-support 12 months earlier than originally communicated.",
    },
  },
  {
    label: "Strong refresh cycle (EXTEND)",
    fill: {
      description: "Fleet of 12 delivery vans",
      category: "VEHICLES",
      originalUsefulLifeMonths: 60,
      monthsInService: 48,
      conditionNotes:
        "Fleet still passing annual inspections; preventive maintenance program in place.",
      externalSignals: "",
    },
  },
];

export function UsefulLifeForm() {
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("COMPUTER_EQUIPMENT");
  const [originalUsefulLifeMonths, setOrig] = useState(36);
  const [monthsInService, setInService] = useState(18);
  const [bookCode, setBookCode] = useState("US_GAAP");
  const [conditionNotes, setNotes] = useState("");
  const [externalSignals, setSignals] = useState("");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ClassifyUsefulLifeState | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState(null);
    startTransition(async () => {
      const r = await classifyUsefulLifeAction({
        facts: {
          description,
          category,
          originalUsefulLifeMonths,
          monthsInService,
          bookCode,
          conditionNotes: conditionNotes || undefined,
          externalSignals: externalSignals || undefined,
        },
      });
      setState(r);
    });
  }

  function fillSample(s: (typeof SAMPLES)[number]["fill"]) {
    setDescription(s.description);
    setCategory(s.category);
    setOrig(s.originalUsefulLifeMonths);
    setInService(s.monthsInService);
    setNotes(s.conditionNotes);
    setSignals(s.externalSignals);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-500">Try a sample:</span>
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            type="button"
            className="rounded border border-ink-200 px-2 py-0.5 text-ink-700 hover:bg-ink-50"
            onClick={() => fillSample(s.fill)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-500">Asset description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. 8 MacBook Pros for engineering team"
          className="rounded border border-ink-200 px-2 py-1.5 font-mono"
        />
      </label>

      <div className="grid grid-cols-4 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1.5 font-mono"
          >
            <option>COMPUTER_EQUIPMENT</option>
            <option>OFFICE_FURNITURE</option>
            <option>VEHICLES</option>
            <option>BUILDINGS_IMPROVEMENTS</option>
            <option>MACHINERY</option>
            <option>INTANGIBLE_SOFTWARE</option>
            <option>INTANGIBLE_OTHER</option>
            <option>OTHER</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Original life (mo)</span>
          <input
            type="number"
            min={1}
            value={originalUsefulLifeMonths}
            onChange={(e) => setOrig(Number(e.target.value))}
            className="rounded border border-ink-200 px-2 py-1.5 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">In service (mo)</span>
          <input
            type="number"
            min={0}
            value={monthsInService}
            onChange={(e) => setInService(Number(e.target.value))}
            className="rounded border border-ink-200 px-2 py-1.5 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Book</span>
          <select
            value={bookCode}
            onChange={(e) => setBookCode(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1.5 font-mono"
          >
            <option>US_GAAP</option>
            <option>US_TAX</option>
            <option>IFRS</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-500">
          Condition notes (optional) — failures, refurbishments, current
          condition observations
        </span>
        <textarea
          rows={2}
          value={conditionNotes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded border border-ink-200 px-2 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-500">
          External signals (optional) — vendor EOL announcements, regulatory
          updates, lease term changes
        </span>
        <textarea
          rows={2}
          value={externalSignals}
          onChange={(e) => setSignals(e.target.value)}
          className="rounded border border-ink-200 px-2 py-1.5 text-sm"
        />
      </label>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !description.trim()}>
          {pending ? "Reassessing…" : "Reassess"}
        </Button>
        {state && !state.ok ? (
          <span className="text-xs text-red-600">{state.message}</span>
        ) : null}
      </div>

      {state?.ok && state.recommendation ? <ResultCard state={state} /> : null}
    </form>
  );
}

function ResultCard({ state }: { state: ClassifyUsefulLifeState }) {
  const r = state.recommendation!;
  const totalTokens = (state.promptTokens ?? 0) + (state.completionTokens ?? 0);
  const cacheHit = (state.cacheReadTokens ?? 0) > 0;

  return (
    <div className="rounded border border-accent-200 bg-accent-50 p-4 mt-2">
      <div className="flex items-baseline justify-between">
        <div>
          <span
            className={
              r.changeKind === "EXTEND"
                ? "text-emerald-700 font-semibold text-lg"
                : r.changeKind === "SHORTEN"
                  ? "text-amber-700 font-semibold text-lg"
                  : "text-ink-800 font-semibold text-lg"
            }
          >
            {r.changeKind === "EXTEND"
              ? "EXTEND useful life"
              : r.changeKind === "SHORTEN"
                ? "SHORTEN useful life"
                : "KEEP — no change"}
          </span>
        </div>
        <div className="text-xs text-ink-500">
          confidence:{" "}
          <span
            className={
              r.confidence >= 0.85
                ? "text-emerald-700 font-medium"
                : r.confidence >= 0.5
                  ? "text-amber-700 font-medium"
                  : "text-red-700 font-medium"
            }
          >
            {(r.confidence * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-ink-500">Recommended useful life</dt>
        <dd className="font-mono text-ink-900">
          {r.recommendedUsefulLifeMonths} months
          {r.delta !== 0 ? (
            <span className="text-ink-500 text-xs ml-2">
              ({r.delta > 0 ? "+" : ""}
              {r.delta} months vs original)
            </span>
          ) : null}
        </dd>
        <dt className="text-ink-500">Remaining life from today</dt>
        <dd className="font-mono text-ink-900">
          {r.remainingLifeMonths} months
        </dd>
        <dt className="text-ink-500">Trigger</dt>
        <dd className="font-mono text-ink-900">{r.triggerType}</dd>
      </dl>

      <div className="mt-3 text-sm text-ink-700">
        <div className="text-xs text-ink-500 mb-1 font-medium uppercase tracking-wider">
          Rationale
        </div>
        {r.rationale}
      </div>

      <div className="mt-3 pt-3 border-t border-accent-200 text-xs text-ink-500 flex flex-wrap gap-x-4 gap-y-1">
        <span>{totalTokens.toLocaleString()} tokens</span>
        <span>{state.latencyMs}ms</span>
        {cacheHit ? (
          <span className="text-emerald-700">
            cache hit ({state.cacheReadTokens?.toLocaleString()} read)
          </span>
        ) : (
          <span className="text-ink-500">
            cache cold ({state.cacheCreationTokens?.toLocaleString()} written)
          </span>
        )}
        <span className="text-ink-400">
          suggestion id: <span className="font-mono">{state.suggestionId}</span>
        </span>
      </div>

      <p className="mt-3 text-xs text-ink-500 italic">
        v0.5 surface: read-only recommendation. To apply, edit the relevant
        FixedAssetBookAttributes row directly. v0.6 will add a one-click
        Accept that updates usefulLifeMonths and recomputes the next
        depreciation run.
      </p>
    </div>
  );
}
