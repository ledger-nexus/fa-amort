// AI impairment-indicator classifier.
//
// Paste free-form text — a news article, an internal memo, a vendor
// announcement, a sales-team email — and ask Claude: does this suggest
// any of our fixed-asset categories might be impaired under ASC 360-10?
//
// This is a SCREENING tool, not a determination. ASC 360-10 impairment
// testing is a multi-step process (recoverability test → fair-value
// measurement → write-down) that requires real numbers, not text
// analysis. The AI only flags categories worth investigating.
//
// Output is structured: a list of impairment indicators identified, each
// with the asset category affected, a severity rating, and rationale.
// CPAs use this to triage which categories deserve a formal recoverability
// test next quarter.
//
// Why this is its own surface (not just "ask the capex classifier"):
// Different decision framework. Capex says capitalize/expense; impairment
// says "these conditions exist + here's what to investigate." Different
// system prompt; different output schema; different audit semantics.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { createHash } from "node:crypto";

export const IMPAIRMENT_MODEL = "claude-opus-4-7";

// The asset categories the firm's chart supports (mirrors the capex
// classifier's enum so a CPA can act on the recommendation by pulling
// up that category's assets).
const AssetCategorySchema = z.enum([
  "COMPUTER_EQUIPMENT",
  "OFFICE_FURNITURE",
  "VEHICLES",
  "BUILDINGS_IMPROVEMENTS",
  "MACHINERY",
  "INTANGIBLE_SOFTWARE",
  "INTANGIBLE_OTHER",
]);

const IndicatorKindSchema = z.enum([
  "MARKET_VALUE_DECLINE",     // significant decrease in market value
  "ADVERSE_BUSINESS_CHANGE",  // significant adverse change in business climate
  "PHYSICAL_DAMAGE",          // physical damage to asset
  "OBSOLESCENCE",             // technological obsolescence
  "REGULATORY_CHANGE",        // regulatory change affecting recoverability
  "OPERATING_LOSSES",         // history or projection of operating losses
  "EARLY_DISPOSAL",           // expectation of disposal earlier than estimated useful life
  "OTHER",
]);

const ImpairmentIndicatorSchema = z.object({
  affectedCategory: AssetCategorySchema.describe(
    "Which asset category the indicator points at. Pick the closest match from our chart."
  ),
  kind: IndicatorKindSchema.describe(
    "The ASC 360-10-35-21 indicator type. MARKET_VALUE_DECLINE for market signals; ADVERSE_BUSINESS_CHANGE for industry shifts; OBSOLESCENCE for tech displacement; REGULATORY_CHANGE for new rules; OPERATING_LOSSES for sustained losses; EARLY_DISPOSAL for expected early sale; PHYSICAL_DAMAGE for explicit damage; OTHER if none fit."
  ),
  severity: z
    .enum(["LOW", "MEDIUM", "HIGH"])
    .describe(
      "How concerning the indicator is. HIGH = recoverability test strongly recommended this quarter. MEDIUM = note in workpapers and monitor. LOW = mention only; probably not material."
    ),
  evidence: z
    .string()
    .max(300)
    .describe(
      "Quote or paraphrase the SPECIFIC text from the input that triggered this indicator. Concrete, not generic. The CPA uses this to verify the AI didn't hallucinate."
    ),
  rationale: z
    .string()
    .max(400)
    .describe(
      "One paragraph: why this evidence matters under ASC 360, what to investigate next (carrying value review, undiscounted cash flow projection, fair-value measurement)."
    ),
});

const ImpairmentResponseSchema = z.object({
  hasImpairmentIndicators: z
    .boolean()
    .describe(
      "true if any indicator was identified. false if the input shows no impairment signal — most articles / memos won't suggest impairment, so this is the typical answer."
    ),
  indicators: z
    .array(ImpairmentIndicatorSchema)
    .describe(
      "Each distinct indicator identified. Empty array when hasImpairmentIndicators is false. Multiple indicators ok if the input touches several asset classes (e.g., a downturn that hits both real estate and equipment)."
    ),
  overallSeverity: z
    .enum(["NONE", "LOW", "MEDIUM", "HIGH"])
    .describe(
      "The highest severity across indicators, or NONE when no indicators. Drives the workpaper-priority cue."
    ),
  summaryNote: z
    .string()
    .max(500)
    .describe(
      "One paragraph for the audit log: what was reviewed, what was concluded, what (if anything) to do next. The CPA can drop this into a quarterly review workpaper."
    ),
});

export type ImpairmentIndicator = z.infer<typeof ImpairmentIndicatorSchema>;
export type ImpairmentResponse = z.infer<typeof ImpairmentResponseSchema>;

export interface ImpairmentResult {
  response: ImpairmentResponse;
  modelName: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  latencyMs: number;
}

const SYSTEM_PROMPT = `You are an ASC 360-10 impairment-indicator screening assistant. You read free-form text (a news article, internal memo, vendor announcement, sales email, regulatory update) and identify whether any of our fixed-asset categories might be IMPAIRED.

You are NOT making an impairment determination. Impairment under ASC 360-10 requires a multi-step test:
  Step 1 — Identify the indicator (your job here)
  Step 2 — Recoverability test: is undiscounted future cash flow < carrying value?
  Step 3 — Measure the loss: fair value vs carrying value
  Step 4 — Recognize the loss + new depreciable base

Steps 2-4 require real numbers from the asset register and forecasts. Those aren't in scope for this screening. Your job is the FIRST step only: flag categories where Step 2 should run this quarter.

ASC 360-10-35-21 LIST OF INDICATORS (be precise about which one applies):

1. MARKET_VALUE_DECLINE — A significant decrease in the market price of a long-lived asset (group).
   Example signal: "Used class-8 trucks selling 30% below KBB this quarter."

2. ADVERSE_BUSINESS_CHANGE — A significant adverse change in the extent or manner in which a long-lived asset is being used, or in its physical condition.
   Example signal: "Closed two warehouses; equipment idle indefinitely."

3. PHYSICAL_DAMAGE — A significant physical change.
   Example signal: "Fire damaged the manufacturing line; partial loss."

4. OBSOLESCENCE — A significant adverse change in legal factors or in the business climate that could affect the value, including an adverse action or assessment by a regulator.
   Example signal: "Cloud-based alternative is making our on-prem servers redundant."

5. REGULATORY_CHANGE — A current-period operating or cash flow loss combined with a history of operating or cash flow losses or a projection or forecast that demonstrates continuing losses associated with the use of the asset.
   Example signal: "New emissions standard makes our diesel fleet non-compliant in 18 months."

6. OPERATING_LOSSES — A current-period operating or cash flow loss combined with a history of operating or cash flow losses or a projection or forecast that demonstrates continuing losses.
   Example signal: "Q3 segment loss is the fifth consecutive."

7. EARLY_DISPOSAL — A current expectation that, more likely than not, a long-lived asset (or asset group) will be sold or otherwise disposed of significantly before the end of its previously estimated useful life.
   Example signal: "Board approved sale of Atlanta facility by Q2 2027."

8. OTHER — Anything else that materially threatens recoverability and isn't one of the above.

SEVERITY GUIDANCE:
- HIGH: The signal is direct, current, and material. Recovery test should run THIS quarter for the affected category.
- MEDIUM: The signal is real but indirect or future-tense. Note in this quarter's workpapers; revisit next quarter.
- LOW: Mentioned in passing; probably not material to recoverability. Note but don't escalate.

CONSERVATIVE BIAS — When in doubt, flag with lower severity rather than skip. The CPA can dismiss; missing a real impairment is more harmful than reviewing a false positive. But:
- Don't invent indicators that aren't in the input. The "evidence" field must quote or paraphrase the actual source text.
- Don't pick OTHER unless the signal is genuinely unique. Force-fit into one of the seven named categories.
- If the input doesn't touch fixed assets at all (e.g., "the marketing team is doing well") → hasImpairmentIndicators=false, indicators=[], severity=NONE.

OUTPUT DISCIPLINE:
- evidence must be concrete and quotable. The CPA verifies by reading it without re-reading the source.
- rationale states WHY this matters under ASC 360 and WHAT to do next (carrying value review, cash flow forecast, fair value estimate).
- summaryNote is workpaper-quality: a CPA could drop it into the quarterly impairment review file.

You are a SCREENING assistant. A human CPA decides whether to run the formal Step 2-4 tests based on what you flag. Be precise; surface uncertainty; don't speculate beyond the evidence in the input.`;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function setClientForTesting(client: Anthropic | null): void {
  _client = client;
}

export async function classifyImpairment(
  sourceText: string
): Promise<ImpairmentResult> {
  if (!sourceText.trim()) {
    throw new Error("sourceText is empty — nothing to screen");
  }

  const userMessage = [
    `Screen the following text for ASC 360-10 impairment indicators affecting our fixed-asset categories.`,
    ``,
    `--- SOURCE BEGIN ---`,
    sourceText,
    `--- SOURCE END ---`,
  ].join("\n");

  const promptHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n---\n")
    .update(userMessage)
    .digest("hex");

  const startedAt = Date.now();
  const response = await getClient().messages.parse({
    model: IMPAIRMENT_MODEL,
    max_tokens: 3072,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(ImpairmentResponseSchema) },
  });
  const latencyMs = Date.now() - startedAt;

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Impairment classifier returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  return {
    response: parsed,
    modelName: IMPAIRMENT_MODEL,
    promptHash,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    latencyMs,
  };
}
