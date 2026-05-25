"use client";

// Client Component: textarea + classify button + result card.
// Drives the classifyCapexAction Server Action and renders the
// structured proposal inline.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  classifyCapexAction,
  type ClassifyCapexState,
} from "@/app/actions/classify-capex";

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

      <p className="mt-3 text-xs text-ink-500 italic">
        v0.2 surface: read-only proposal. Acceptance (creating a FixedAsset
        from this) lands in v0.3 — for now, a CPA copies the values into the
        existing fixed-asset creation flow.
      </p>
    </div>
  );
}
