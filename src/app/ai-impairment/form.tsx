"use client";

// Client Component: impairment-indicator screening form + result card.
// After a screening, the user can FLAG (escalate to workpapers) or
// DISMISS (no follow-up needed) — both stamp the audit row.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  classifyImpairmentAction,
  decideImpairmentAction,
  type ClassifyImpairmentState,
} from "@/app/actions/classify-impairment";

const SAMPLES = [
  {
    label: "Neutral (NONE)",
    fill: {
      label: "Q3 roadmap update",
      text: "Q3 product roadmap update: new mobile app features shipped, customer engagement up 15%, hiring two more engineers next quarter.",
    },
  },
  {
    label: "Vendor EOL (LOW/MEDIUM)",
    fill: {
      label: "Vendor announcement",
      text: "Cisco today announced end-of-support for the Catalyst 9300 series in 18 months, ahead of the originally communicated 36-month timeline. Customers are advised to plan migration paths.",
    },
  },
  {
    label: "Facility closure (HIGH)",
    fill: {
      label: "Internal memo — facility closure",
      text: "Internal memo, dated 2026-08-15:\n\nThe board has approved closure of the Atlanta warehouse facility by Q2 2027 in response to ongoing operational losses. The 50,000 sqft facility, including leasehold improvements and warehouse machinery installed in 2024, will be listed for sublease in October. Q3 segment showed our fifth consecutive quarter of operating losses for the Eastern region.",
    },
  },
];

export function ImpairmentForm() {
  const [sourceLabel, setLabel] = useState("");
  const [sourceText, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ClassifyImpairmentState | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState(null);
    startTransition(async () => {
      const r = await classifyImpairmentAction({
        sourceText,
        sourceLabel: sourceLabel || undefined,
      });
      setState(r);
    });
  }

  function fillSample(s: (typeof SAMPLES)[number]["fill"]) {
    setLabel(s.label);
    setText(s.text);
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
        <span className="text-xs text-ink-500">
          Source label (optional) — appears in the audit log
        </span>
        <input
          value={sourceLabel}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='e.g. "Q3 industry report excerpt" or "Vendor EOL announcement"'
          className="rounded border border-ink-200 px-2 py-1.5 font-mono"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-ink-500">Source text</span>
        <textarea
          rows={8}
          value={sourceText}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the article, memo, announcement, or update here. The model needs enough context to identify which asset categories (if any) might be affected."
          className="rounded border border-ink-200 px-2 py-1.5 text-sm"
        />
      </label>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !sourceText.trim()}>
          {pending ? "Screening…" : "Screen for indicators"}
        </Button>
        {state && !state.ok ? (
          <span className="text-xs text-red-600">{state.message}</span>
        ) : null}
      </div>

      {state?.ok && state.response ? <ResultCard state={state} /> : null}
    </form>
  );
}

function ResultCard({ state }: { state: ClassifyImpairmentState }) {
  const resp = state.response!;
  const totalTokens = (state.promptTokens ?? 0) + (state.completionTokens ?? 0);
  const cacheHit = (state.cacheReadTokens ?? 0) > 0;
  const [decision, setDecision] = useState<
    "PENDING" | "FLAGGED" | "DISMISSED"
  >("PENDING");
  const [decideError, setDecideError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(d: "FLAGGED" | "DISMISSED") {
    setDecideError(null);
    startTransition(async () => {
      const r = await decideImpairmentAction({
        suggestionId: state.suggestionId!,
        decision: d,
      });
      if (!r.ok) setDecideError(r.message ?? "Decision failed");
      else setDecision(d);
    });
  }

  const severityClass =
    resp.overallSeverity === "HIGH"
      ? "text-red-700"
      : resp.overallSeverity === "MEDIUM"
        ? "text-amber-700"
        : resp.overallSeverity === "LOW"
          ? "text-ink-700"
          : "text-emerald-700";

  return (
    <div className="rounded border border-accent-200 bg-accent-50 p-4 mt-2">
      <div className="flex items-baseline justify-between">
        <div>
          {resp.hasImpairmentIndicators ? (
            <span className={`${severityClass} font-semibold text-lg`}>
              {resp.indicators.length} indicator
              {resp.indicators.length === 1 ? "" : "s"} identified
            </span>
          ) : (
            <span className="text-emerald-700 font-semibold text-lg">
              No impairment indicators
            </span>
          )}
        </div>
        <div className="text-xs text-ink-500">
          overall severity:{" "}
          <span className={`${severityClass} font-medium`}>
            {resp.overallSeverity}
          </span>
        </div>
      </div>

      {resp.indicators.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {resp.indicators.map((ind, i) => (
            <div
              key={i}
              className="rounded border border-ink-200 bg-white p-3 text-sm"
            >
              <div className="flex items-baseline gap-2 mb-1">
                <span className="font-mono text-xs text-ink-700">
                  {ind.affectedCategory}
                </span>
                <span className="font-mono text-xs text-ink-500">
                  · {ind.kind}
                </span>
                <span
                  className={`text-xs font-medium ml-auto ${
                    ind.severity === "HIGH"
                      ? "text-red-700"
                      : ind.severity === "MEDIUM"
                        ? "text-amber-700"
                        : "text-ink-600"
                  }`}
                >
                  {ind.severity}
                </span>
              </div>
              <div className="text-xs text-ink-500 mt-2 italic">
                Evidence: &quot;{ind.evidence}&quot;
              </div>
              <div className="text-sm text-ink-800 mt-2">{ind.rationale}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 text-sm text-ink-700">
        <div className="text-xs text-ink-500 mb-1 font-medium uppercase tracking-wider">
          Summary note (audit-log quality)
        </div>
        {resp.summaryNote}
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

      {/* Decision controls — FLAG escalates to workpapers; DISMISS closes
          without follow-up. Both stamp the audit row. */}
      <div className="mt-4 pt-3 border-t border-accent-200">
        {decision !== "PENDING" ? (
          <span
            className={
              decision === "FLAGGED"
                ? "text-amber-700 text-sm font-medium"
                : "text-ink-700 text-sm font-medium"
            }
          >
            {decision === "FLAGGED" ? "⚑ Flagged" : "✓ Dismissed"}
            <span className="text-xs text-ink-500 ml-2">
              {decision === "FLAGGED"
                ? "— add to this quarter's impairment workpapers and run a formal recoverability test on the affected categories."
                : "— audit row stays as proof of review."}
            </span>
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => decide("FLAGGED")}
              disabled={pending}
            >
              {pending ? "…" : "Flag for follow-up"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => decide("DISMISSED")}
              disabled={pending}
            >
              Dismiss
            </Button>
            {decideError ? (
              <span className="text-xs text-red-600">{decideError}</span>
            ) : null}
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-500 italic">
        Impairment recognition is off-system. After flagging, run the formal
        ASC 360-10 recoverability test (carrying value vs undiscounted cash
        flows) and post the write-down JE manually through ledger-core if
        the test fails.
      </p>
    </div>
  );
}
