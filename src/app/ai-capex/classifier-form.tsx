"use client";

// Client Component: textarea + classify button + result card.
// Drives the classifyCapexAction Server Action and renders the
// structured proposal inline.
//
// After v0.3 the result card also offers Accept / Reject. Accept
// reveals a pre-filled form (entity, asset code, cost, books) and
// posts to ledger-core via the bridge. Reject just stamps the audit
// row.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  classifyCapexAction,
  type ClassifyCapexState,
} from "@/app/actions/classify-capex";
import {
  acceptCapexSuggestionAction,
  rejectCapexSuggestionAction,
  type AcceptCapexState,
} from "@/app/actions/decide-capex";

const SAMPLES = [
  {
    label: "Capex clear-cut",
    text: "Vendor: Cisco. 4× Catalyst 9300 48-port switches @ $3,500 each. Replaces failing network hardware. Total: $14,000.",
  },
  {
    label: "Expense clear-cut",
    text: "Vendor: Slack Technologies. Annual subscription, 50 seats × $12.50/mo. Total: $7,500/year.",
  },
  {
    label: "Judgment call (software)",
    text: "Vendor: External dev shop. Custom-built CRM module, 6-month engagement, $80,000 fixed-fee. Internal-use; not sold to customers.",
  },
];

export function ClassifierForm() {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ClassifyCapexState | null>(null);

  function handleClassify() {
    setState(null);
    startTransition(async () => {
      const r = await classifyCapexAction({ invoiceText: text });
      setState(r);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-500">Try a sample:</span>
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            type="button"
            className="rounded border border-ink-200 px-2 py-0.5 text-ink-700 hover:bg-ink-50"
            onClick={() => setText(s.text)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a purchase description here — vendor, item, dollar amount, term if applicable."
        className="rounded border border-ink-200 px-3 py-2 text-sm font-mono"
      />

      <div className="flex items-center gap-2">
        <Button
          onClick={handleClassify}
          disabled={pending || !text.trim()}
        >
          {pending ? "Classifying…" : "Classify"}
        </Button>
        {state && !state.ok ? (
          <span className="text-xs text-red-600">{state.message}</span>
        ) : null}
      </div>

      {state?.ok && state.classification ? (
        <ResultCard state={state} />
      ) : null}
    </div>
  );
}

function ResultCard({ state }: { state: ClassifyCapexState }) {
  const c = state.classification!;
  const totalTokens = (state.promptTokens ?? 0) + (state.completionTokens ?? 0);
  const cacheHit = (state.cacheReadTokens ?? 0) > 0;
  const [decision, setDecision] = useState<
    "PENDING" | "ACCEPTED" | "REJECTED" | "FORM_OPEN"
  >("PENDING");

  return (
    <div className="rounded border border-accent-200 bg-accent-50 p-4 mt-2">
      <div className="flex items-baseline justify-between">
        <div>
          {c.capitalize ? (
            <span className="text-emerald-700 font-semibold text-lg">
              CAPITALIZE as a fixed asset
            </span>
          ) : (
            <span className="text-amber-700 font-semibold text-lg">
              EXPENSE in the period
            </span>
          )}
        </div>
        <div className="text-xs text-ink-500">
          confidence:{" "}
          <span
            className={
              c.confidence >= 0.85
                ? "text-emerald-700 font-medium"
                : c.confidence >= 0.5
                  ? "text-amber-700 font-medium"
                  : "text-red-700 font-medium"
            }
          >
            {(c.confidence * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* AI-extracted preamble — what the model read out of the input. */}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-ink-500">Description</dt>
        <dd className="text-ink-900">{c.description}</dd>
        <dt className="text-ink-500">Estimated cost</dt>
        <dd className="font-mono text-ink-900">
          {c.estimatedCost != null
            ? `$${c.estimatedCost.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
            : "—"}
        </dd>
        <dt className="text-ink-500">Vendor</dt>
        <dd className="text-ink-900">{c.vendorName ?? "—"}</dd>
      </dl>

      {c.capitalize ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-ink-500">Category</dt>
          <dd className="font-mono text-ink-900">{c.category ?? "—"}</dd>
          <dt className="text-ink-500">Useful life</dt>
          <dd className="font-mono text-ink-900">
            {c.usefulLifeMonths ?? "—"} months
          </dd>
          <dt className="text-ink-500">Salvage value</dt>
          <dd className="font-mono text-ink-900">
            {c.salvageValuePercent != null ? `${c.salvageValuePercent}%` : "—"}
          </dd>
          <dt className="text-ink-500">Asset account</dt>
          <dd className="font-mono text-ink-900">
            {c.recommendedAssetAccountCode ?? "—"}
          </dd>
          <dt className="text-ink-500">Depreciation expense</dt>
          <dd className="font-mono text-ink-900">
            {c.recommendedDepreciationExpenseAccountCode ?? "—"}
          </dd>
          <dt className="text-ink-500">Accum depreciation</dt>
          <dd className="font-mono text-ink-900">
            {c.recommendedAccumDepreciationAccountCode ?? "—"}
          </dd>
        </dl>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-ink-500">Expense account</dt>
          <dd className="font-mono text-ink-900">
            {c.recommendedExpenseAccountCode ?? "—"}
          </dd>
        </dl>
      )}

      <div className="mt-3 text-sm text-ink-700">
        <div className="text-xs text-ink-500 mb-1 font-medium uppercase tracking-wider">
          Rationale
        </div>
        {c.rationale}
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

      {/* Accept / Reject controls */}
      <DecisionControls
        state={state}
        decision={decision}
        setDecision={setDecision}
      />
    </div>
  );
}

function DecisionControls({
  state,
  decision,
  setDecision,
}: {
  state: ClassifyCapexState;
  decision: "PENDING" | "ACCEPTED" | "REJECTED" | "FORM_OPEN";
  setDecision: (d: "PENDING" | "ACCEPTED" | "REJECTED" | "FORM_OPEN") => void;
}) {
  const c = state.classification!;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [acceptResult, setAcceptResult] = useState<AcceptCapexState | null>(null);

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const r = await rejectCapexSuggestionAction({
        suggestionId: state.suggestionId!,
      });
      if (!r.ok) setError(r.message ?? "Reject failed");
      else setDecision("REJECTED");
    });
  }

  if (decision === "REJECTED") {
    return (
      <div className="mt-4 pt-3 border-t border-accent-200">
        <span className="text-amber-700 text-sm font-medium">
          ✗ Rejected.
        </span>{" "}
        <span className="text-xs text-ink-500">
          Audit row stays at /ai-audit as proof the human reviewed it.
        </span>
      </div>
    );
  }
  if (decision === "ACCEPTED" && acceptResult?.ok) {
    return (
      <div className="mt-4 pt-3 border-t border-accent-200">
        <span className="text-emerald-700 text-sm font-medium">
          ✓ Accepted.
        </span>{" "}
        <span className="text-xs text-ink-600">{acceptResult.message}</span>
        {acceptResult.assetCode ? (
          <>
            {" · "}
            <a
              href={`/fixed-assets`}
              className="text-xs text-accent-600 hover:underline"
            >
              View on /fixed-assets →
            </a>
          </>
        ) : null}
      </div>
    );
  }
  if (decision === "FORM_OPEN") {
    return (
      <AcceptForm
        state={state}
        onCancel={() => setDecision("PENDING")}
        onAccepted={(r) => {
          setAcceptResult(r);
          setDecision("ACCEPTED");
        }}
      />
    );
  }

  // PENDING — show Accept / Reject buttons.
  // Hide Accept entirely for expense classifications: there's no asset
  // to create, just a chart-of-accounts hint.
  return (
    <div className="mt-4 pt-3 border-t border-accent-200 flex items-center gap-2">
      {c.capitalize ? (
        <Button onClick={() => setDecision("FORM_OPEN")} disabled={pending}>
          Accept & create FixedAsset
        </Button>
      ) : null}
      <Button variant="ghost" onClick={handleReject} disabled={pending}>
        {pending ? "…" : "Reject"}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
      {!c.capitalize ? (
        <span className="text-xs text-ink-500">
          Expense classifications don&apos;t create assets — close out by
          marking as reviewed.
        </span>
      ) : null}
    </div>
  );
}

function AcceptForm({
  state,
  onCancel,
  onAccepted,
}: {
  state: ClassifyCapexState;
  onCancel: () => void;
  onAccepted: (r: AcceptCapexState) => void;
}) {
  const c = state.classification!;
  // Generate a default asset code from today's date + random suffix.
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const yearMonth = todayIso.slice(0, 7).replace("-", "");
  const defaultCode = `FA-${yearMonth}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;

  const [entityCode, setEntityCode] = useState("DEMO_CO");
  const [assetCode, setAssetCode] = useState(defaultCode);
  const [acquisitionDate, setAcquisitionDate] = useState(todayIso);
  const [acquisitionCost, setAcquisitionCost] = useState(
    c.estimatedCost?.toString() ?? ""
  );
  const [bookGaap, setBookGaap] = useState(true);
  const [bookTax, setBookTax] = useState(true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const books: Array<{
      bookCode: string;
      usefulLifeMonths: number;
      salvageValuePercent: number;
      inServiceDate: string;
      depreciationExpenseAccountCode: string;
      accumDepreciationAccountCode: string;
    }> = [];
    if (bookGaap) {
      books.push({
        bookCode: "US_GAAP",
        usefulLifeMonths: c.usefulLifeMonths ?? 60,
        salvageValuePercent: c.salvageValuePercent ?? 0,
        inServiceDate: acquisitionDate,
        depreciationExpenseAccountCode:
          c.recommendedDepreciationExpenseAccountCode ?? "8000",
        accumDepreciationAccountCode:
          c.recommendedAccumDepreciationAccountCode ?? "1510",
      });
    }
    if (bookTax) {
      // Tax usually uses a longer MACRS-equivalent life; for v0.3
      // simplicity we send the same useful life as GAAP. v0.4 can wire
      // the MACRS lookup.
      books.push({
        bookCode: "US_TAX",
        usefulLifeMonths: c.usefulLifeMonths ?? 60,
        salvageValuePercent: c.salvageValuePercent ?? 0,
        inServiceDate: acquisitionDate,
        depreciationExpenseAccountCode:
          c.recommendedDepreciationExpenseAccountCode ?? "8000",
        accumDepreciationAccountCode:
          c.recommendedAccumDepreciationAccountCode ?? "1510",
      });
    }
    if (books.length === 0) {
      setError("Select at least one book (US_GAAP or US_TAX).");
      return;
    }

    startTransition(async () => {
      const r = await acceptCapexSuggestionAction({
        suggestionId: state.suggestionId!,
        entityCode,
        assetCode,
        description: c.description,
        category: c.category ?? undefined,
        acquisitionDate,
        acquisitionCost: Number(acquisitionCost),
        acquisitionCurrencyCode: "USD",
        assetAccountCode: c.recommendedAssetAccountCode ?? "1500",
        books,
      });
      if (!r.ok) setError(r.message ?? "Accept failed");
      else onAccepted(r);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 pt-3 border-t border-accent-200 flex flex-col gap-3"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-ink-500">
        Confirm asset details
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Entity code</span>
          <input
            value={entityCode}
            onChange={(e) => setEntityCode(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Asset code</span>
          <input
            value={assetCode}
            onChange={(e) => setAssetCode(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Acquisition date</span>
          <input
            type="date"
            value={acquisitionDate}
            onChange={(e) => setAcquisitionDate(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-500">Cost (USD)</span>
          <input
            type="number"
            step="0.01"
            value={acquisitionCost}
            onChange={(e) => setAcquisitionCost(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 font-mono"
            placeholder="e.g. 14000.00"
          />
        </label>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="text-xs text-ink-500">Track in books:</span>
        <label className="flex items-center gap-1.5 text-ink-700">
          <input
            type="checkbox"
            checked={bookGaap}
            onChange={(e) => setBookGaap(e.target.checked)}
          />
          <span className="font-mono">US_GAAP</span>
        </label>
        <label className="flex items-center gap-1.5 text-ink-700">
          <input
            type="checkbox"
            checked={bookTax}
            onChange={(e) => setBookTax(e.target.checked)}
          />
          <span className="font-mono">US_TAX</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create FixedAsset"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </form>
  );
}
