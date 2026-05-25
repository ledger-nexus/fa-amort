// AI useful-life classifier.
//
// Given an existing asset's facts (description, original useful life,
// current age, condition observations, any contract/lease implications),
// ask Claude to RECONSIDER the useful life. Used for two common
// scenarios:
//
//   1. Mid-life reassessment ("the laptops are still going strong at
//      year 4, should we extend the life past the original 36 months?")
//   2. Triggered reassessment (vendor announces end-of-support; lease
//      term shortens unexpectedly; regulatory life-table updates)
//
// Outputs a structured recommendation. The CPA reviews; if accepted,
// the new useful life replaces the existing FixedAssetBookAttributes.
// usefulLifeMonths value, and the per-book schedule recomputes from
// the next depreciation run.
//
// Prompt caching is on the system prefix (the useful-life policy +
// industry-standard tables). The asset-specific facts vary per call.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { createHash } from "node:crypto";

export const USEFUL_LIFE_MODEL = "claude-opus-4-7";

// What does the AI need from us to reassess? Same shape we'd hand a
// human reviewer.
export interface AssetFactSheet {
  description: string;
  category: string;             // e.g. "COMPUTER_EQUIPMENT", "VEHICLES"
  originalUsefulLifeMonths: number;
  monthsInService: number;
  bookCode: string;             // e.g. "US_GAAP" — different books may diverge
  conditionNotes?: string;      // free-form: "1 unit failed in Y2", "all hardware extended warranty"
  externalSignals?: string;     // vendor EOL announcement, regulatory update, lease term change
}

const RecommendationSchema = z.object({
  recommendedUsefulLifeMonths: z
    .number()
    .int()
    .min(1)
    .max(480)
    .describe(
      "Revised total useful life in months from in-service date. NOT the remaining life — the new total."
    ),
  delta: z
    .number()
    .int()
    .describe(
      "recommendedUsefulLifeMonths - originalUsefulLifeMonths. Negative = shorten; positive = extend; 0 = keep."
    ),
  remainingLifeMonths: z
    .number()
    .int()
    .min(0)
    .describe(
      "How many months remain from today (recommendedUsefulLifeMonths - monthsInService). Clamped at 0; if the AI recommends a life shorter than what's already elapsed, this is 0 and the asset is fully depreciated."
    ),
  changeKind: z
    .enum(["KEEP", "EXTEND", "SHORTEN"])
    .describe(
      "KEEP if delta is 0, EXTEND if positive, SHORTEN if negative. Mirrors delta sign but more readable."
    ),
  triggerType: z
    .enum([
      "MID_LIFE_REVIEW",
      "VENDOR_EOL",
      "REGULATORY_UPDATE",
      "LEASE_CHANGE",
      "PHYSICAL_DAMAGE",
      "OBSOLESCENCE",
      "OTHER",
    ])
    .describe(
      "What kind of reassessment trigger applies. MID_LIFE_REVIEW is the routine annual check; the others are event-driven."
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0..1 self-rated confidence. Above 0.85 = clear-cut; auto-suggest after review. 0.5–0.85 = needs CPA judgment. Below 0.5 = surface for explicit second opinion."
    ),
  rationale: z
    .string()
    .max(500)
    .describe(
      "One-paragraph audit-trail explanation. Cite the trigger, the industry-standard life if relevant, the impact on depreciation expense going forward, and any GAAP guidance applied (ASC 250-10-45-17 for changes in accounting estimate)."
    ),
});

export type UsefulLifeRecommendation = z.infer<typeof RecommendationSchema>;

export interface UsefulLifeResult {
  recommendation: UsefulLifeRecommendation;
  modelName: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  latencyMs: number;
}

const SYSTEM_PROMPT = `You are a US GAAP useful-life reassessment assistant. You read an asset's facts (description, original useful life, months in service, condition observations, any external signals) and produce a structured recommendation that a CPA will review.

The decision framework:

1. GAAP TREATMENT (ASC 250-10-45-17)
Changes in useful life are treated as a CHANGE IN ACCOUNTING ESTIMATE, applied prospectively. The remaining net book value depreciates over the new remaining useful life. NO restatement of prior periods. NO catch-up adjustment.

This means: if you recommend extending the life from 36 to 60 months and the asset has been in service for 24 months, the remaining NBV depreciates over (60 - 24) = 36 more months going forward.

2. WHEN TO KEEP THE EXISTING LIFE
Routine "the asset is performing as expected at the midway point" reviews almost always KEEP. Don't churn the books over normal aging. Confidence on KEEP should be high (0.85+) when the only data point is "asset is still in service."

3. WHEN TO EXTEND
- Vendor announces continued support past the original EOL
- Asset class is performing better than initial estimates (statistical, not anecdotal)
- Maintenance / refurbishment investment has materially restored remaining value
- Industry-standard life has been revised upward (e.g., IRS publication update)

4. WHEN TO SHORTEN
- Vendor announces earlier-than-expected end of life / end of support
- Asset has suffered physical damage that reduces remaining service capacity
- Regulatory change makes the asset obsolete (e.g., emissions standards forcing vehicle retirement)
- Technology obsolescence is materially faster than initial estimate
- Lease term shortens (for leasehold improvements)
- BUT if the trigger is so severe the asset is unrecoverable, flag IMPAIRMENT instead — that's a separate AI surface and a different accounting treatment.

5. USEFUL LIFE ANCHORS (months)
Computer equipment:    36-60   (industry standard; refresh cycle drives the call)
Vehicles:              60-84   (mileage + condition; commercial fleets often 84)
Office furniture:      84-180  (very long-lived; rarely revised)
Manufacturing equip:   84-120
Leasehold improvements: lesser of useful life or REMAINING LEASE TERM
Internal-use software: 36-60   (ASC 350-40)
Software with major upgrades: extend each time the upgrade meets the capitalization threshold

6. CONFIDENCE SELF-RATING
Above 0.85: trigger is clear, recommended life sits within the industry-standard range, the rationale fits in one sentence. Auto-suggest after light review.
0.5–0.85: trigger is real but the magnitude is judgment-dependent. Surface for a CPA call.
Below 0.5: input is ambiguous or insufficient. Recommend KEEP and flag the gap in rationale.

7. THE REMAINING-LIFE FLOOR
If the recommended useful life is LESS than monthsInService, the asset is already past its new useful life. Remaining life is 0; the rest of the NBV catches up in the next depreciation run (per ASC 250 prospective rule, NOT a retrospective adjustment). In this case rationale should note that the next month's depreciation will be larger than usual due to the catch-up.

8. RATIONALE STYLE
Concrete sentences. Reference the trigger, the GAAP rule (ASC 250-10-45-17), the impact on monthly depreciation. The CPA should be able to drop the rationale into a workpaper.

You produce a recommendation. A human CPA reviews everything before any FixedAssetBookAttributes row is updated. Be precise; surface your uncertainty.`;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function setClientForTesting(client: Anthropic | null): void {
  _client = client;
}

export async function classifyUsefulLife(
  facts: AssetFactSheet
): Promise<UsefulLifeResult> {
  if (!facts.description?.trim()) {
    throw new Error("AssetFactSheet.description is empty — nothing to classify");
  }

  const userMessage = [
    `Reassess the useful life of this asset under US GAAP / ASC 250.`,
    ``,
    `--- ASSET FACTS BEGIN ---`,
    `Description: ${facts.description}`,
    `Category: ${facts.category}`,
    `Book: ${facts.bookCode}`,
    `Original useful life: ${facts.originalUsefulLifeMonths} months`,
    `Months in service so far: ${facts.monthsInService}`,
    facts.conditionNotes ? `Condition notes: ${facts.conditionNotes}` : null,
    facts.externalSignals ? `External signals: ${facts.externalSignals}` : null,
    `--- ASSET FACTS END ---`,
  ]
    .filter(Boolean)
    .join("\n");

  const promptHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n---\n")
    .update(userMessage)
    .digest("hex");

  const startedAt = Date.now();
  const response = await getClient().messages.parse({
    model: USEFUL_LIFE_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(RecommendationSchema) },
  });
  const latencyMs = Date.now() - startedAt;

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Useful-life classifier returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  return {
    recommendation: parsed,
    modelName: USEFUL_LIFE_MODEL,
    promptHash,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    latencyMs,
  };
}
