// AI capex classifier.
//
// Given a free-form purchase description (AP invoice line, vendor quote,
// receipt OCR text), ask Claude to decide:
//
//   - Is this CAPEX (should be capitalized as a fixed asset) or OPEX
//     (period expense)?
//   - If CAPEX: what category, useful-life-months, and salvage-value
//     percentage are appropriate?
//   - What GL accounts on the existing chart should it post to?
//
// Output is structured (Zod-typed via messages.parse + zodOutputFormat)
// so the downstream Server Action can persist a faithful audit row
// and the UI can render the proposal without further parsing.
//
// Why Opus 4.7 (not Haiku):
//
//   This is judgment-heavy. "Cisco switches, $14k" → capitalize, 5-year
//   life (IT Equipment). "Office snacks, $300" → expense. "Custom
//   software subscription, $50k/year, 3-year term" → capitalize the
//   prepayment (ASC 350-40 internal-use software) or expense as ratable
//   subscription? That's a real call requiring reasoning over the
//   contract terms, the threshold dollar amount, and the firm's
//   capitalization policy. Haiku would miss the nuance.
//
//   Same call revenue-rec made for its extractor: Opus for interpretation,
//   not Haiku ranking. Cost is a few cents per classification; ROI
//   shows up the first time it correctly catches a $20k purchase
//   someone tried to expense.
//
// Prompt caching:
//
//   System prompt (the capex policy guide) wraps in
//   `cache_control: {type: "ephemeral"}`. Across many classifications
//   the policy is stable; the invoice text varies. Verify cache hits
//   via `usage.cache_read_input_tokens > 0` after the first call.
//
// What this module does NOT do:
//   - Persist anything (caller writes AiAssetSuggestion)
//   - Create the FixedAsset row (caller does, after human approval)
//   - Post the JE (out of scope — that's a later step in the workflow)

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { createHash } from "node:crypto";

export const CAPEX_CLASSIFIER_MODEL = "claude-opus-4-7";

// Categories the firm's chart supports. The model is forced to pick
// from this enum so downstream code doesn't have to deal with
// freeform strings.
const CapexCategorySchema = z.enum([
  "COMPUTER_EQUIPMENT",       // laptops, servers, network gear — 5 yr typical
  "OFFICE_FURNITURE",         // desks, chairs, conference room — 7 yr typical
  "VEHICLES",                 // company cars, trucks — 5 yr typical
  "BUILDINGS_IMPROVEMENTS",   // leasehold improvements — 15 yr (or lease term)
  "MACHINERY",                // production equipment — 7 yr typical
  "INTANGIBLE_SOFTWARE",      // capitalized internal-use software — 3 yr typical
  "INTANGIBLE_OTHER",         // patents, trademarks — varies
  "OTHER",                    // anything else — caller decides
]);

const ClassificationSchema = z.object({
  // The pre-fill fields the Accept form uses to create a FixedAsset
  // without making the human re-type what the AI already extracted.
  description: z
    .string()
    .max(120)
    .describe(
      "One-line asset description suitable for the FixedAsset.description column. Match the source text but in a clean form, e.g. '4× Cisco Catalyst 9300 switches'."
    ),
  estimatedCost: z
    .number()
    .nullable()
    .describe(
      "Total cost in dollars, extracted from the input. NULL if the input doesn't state a dollar amount. Use the TOTAL (not unit price)."
    ),
  vendorName: z
    .string()
    .max(120)
    .nullable()
    .describe(
      "Vendor name if stated in the input. NULL if no vendor is named. Plain string, e.g. 'Cisco' or 'Amazon Web Services'."
    ),
  capitalize: z
    .boolean()
    .describe(
      "true if this should be capitalized as a fixed asset, false if it should be expensed in the period of purchase."
    ),
  category: CapexCategorySchema.nullable().describe(
    "Asset category if capitalized. NULL when capitalize is false (the purchase is just an expense)."
  ),
  usefulLifeMonths: z
    .number()
    .int()
    .min(1)
    .max(480)
    .nullable()
    .describe(
      "Useful life in months. NULL when capitalize is false. Use industry-standard lives: 36 (3yr) for software, 60 (5yr) for IT equipment / vehicles, 84 (7yr) for office furniture / machinery, 180 (15yr) for leasehold improvements."
    ),
  salvageValuePercent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe(
      "Estimated salvage value as a percentage of cost. NULL when capitalize is false. Most equipment is 0% (no meaningful residual at end of useful life). Vehicles often 10–20%. Buildings 5–10%. When in doubt, 0%."
    ),
  recommendedAssetAccountCode: z
    .string()
    .nullable()
    .describe(
      "GL account code for the gross asset. NULL when capitalize is false. Use 1500 for computer equipment, 1600 for office furniture, 1700 for vehicles, 1800 for buildings/improvements, 1900 for software/intangibles."
    ),
  recommendedDepreciationExpenseAccountCode: z
    .string()
    .nullable()
    .describe(
      "GL account code for the monthly depreciation expense. NULL when capitalize is false. Use 8000 for tangible-asset depreciation, 8010 for intangible-asset amortization."
    ),
  recommendedAccumDepreciationAccountCode: z
    .string()
    .nullable()
    .describe(
      "GL account code for the contra-asset accumulated depreciation. NULL when capitalize is false. Use 1510 for tangible-asset accum dep, 1910 for intangible-asset accum amortization."
    ),
  recommendedExpenseAccountCode: z
    .string()
    .nullable()
    .describe(
      "GL account code if NOT capitalized (i.e., expensed). NULL when capitalize is true. Use 5000 for COGS-hosting, 7000 for SaaS tools, 7100 for marketing, 7200 for professional fees, 7300 for office/general."
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0..1 self-rated confidence. Above 0.85 = safe to auto-accept after light review. 0.5–0.85 = needs CPA judgment. Below 0.5 = flag for explicit second opinion."
    ),
  rationale: z
    .string()
    .max(500)
    .describe(
      "One-paragraph explanation a CPA can audit. Cite the materiality threshold, useful-life basis, and any uncertainty. Concrete sentences only — no hedging filler."
    ),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassificationResult {
  classification: Classification;
  modelName: string;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  latencyMs: number;
}

// Stable system prefix — high cache-hit rate across many invoice lines.
// Edits invalidate the cache for every downstream call. Treat like a
// schema migration; document the change in CLAUDE.md.
const SYSTEM_PROMPT = `You are a US GAAP capex/opex classification assistant. You read a purchase description (often an AP invoice line, vendor quote, or receipt text) and produce a structured recommendation that a CPA will review before any fixed asset is created or any expense is posted.

The decision framework:

1. CAPITALIZATION THRESHOLD
The firm's policy is to capitalize tangible assets with a unit cost of $2,500 or more AND a useful life of more than 1 year. Below the threshold OR with a life of one year or less, expense the purchase. State the policy threshold in your rationale whenever you invoke it.

2. WHAT GETS CAPITALIZED
Hardware (computers, servers, network gear, peripherals over the threshold): YES.
Furniture, fixtures, equipment over the threshold with multi-year useful life: YES.
Vehicles: YES, with salvage value (typically 10–20% of cost).
Leasehold improvements: YES, amortized over the LESSER of useful life or remaining lease term.
Internal-use software development costs (per ASC 350-40): YES, if in the development phase AND will be used internally.
Off-the-shelf software with a perpetual license: usually YES if over threshold.

3. WHAT DOES NOT GET CAPITALIZED (i.e., expense it)
SaaS subscriptions (Datadog, Salesforce, Slack, etc.): NO. Per ASC 350-40 these are typically service contracts.
Repairs and maintenance: NO. (Major improvements that EXTEND useful life can be capitalized — flag this case in notes.)
Supplies, office snacks, travel: NO.
Marketing, advertising spend: NO.
Professional fees (legal, accounting, consulting) UNLESS they relate to a specific asset's acquisition or development: NO.
Training costs: NO (per ASC 350-40, even for capitalized software, training is expensed).

4. USEFUL LIFE GUIDELINES (months)
36  (3 yr)  — Internal-use software, mobile devices
60  (5 yr)  — Computer equipment, vehicles, network gear
84  (7 yr)  — Office furniture, manufacturing equipment
180 (15 yr) — Leasehold improvements (or lease term if shorter)
Use these unless the contract / vendor docs justify a different life.

5. SALVAGE VALUE
0% for most equipment (no meaningful residual).
10–20% for vehicles.
5–10% for buildings.
When in doubt, use 0% — under-estimating salvage produces conservative (higher) depreciation, which is GAAP-preferred.

6. GL ACCOUNT RECOMMENDATIONS
This firm's chart for capex:
  Asset side:
    1500 — Computer Equipment
    1510 — Accum Dep — Computer Equipment (contra)
    1600 — Office Furniture & Fixtures
    1610 — Accum Dep — Office F&F (contra)
    1700 — Vehicles
    1710 — Accum Dep — Vehicles (contra)
    1800 — Leasehold Improvements
    1810 — Accum Dep — Leasehold Improvements (contra)
    1900 — Capitalized Software / Intangibles
    1910 — Accum Amortization — Software (contra)
  Expense side (depreciation):
    8000 — Depreciation Expense (tangibles)
    8010 — Amortization Expense (intangibles)
  Expense side (operating, when NOT capitalized):
    5000 — Cost of Revenue — Hosting
    7000 — Software & SaaS Tools
    7100 — Marketing
    7200 — Professional Fees
    7300 — Office & General
    7400 — Rent Expense
    7500 — Bad Debt Expense

7. CONFIDENCE SELF-RATING
Above 0.85: clear-cut. The policy gives a definitive answer. Examples: "Cisco switches, $14k" (capitalize, 5yr); "Slack subscription, $5k/yr" (expense per ASC 350-40).
0.5–0.85: judgment call. Examples: "Custom Salesforce implementation, $80k" (could be capitalized internal-use software OR expensed depending on configuration vs. development split); "office refurb, $4k" (capitalize as leasehold improvement OR expense as repair?).
Below 0.5: insufficient information. Ask for clarification in the rationale before claiming an answer.

8. RATIONALE STYLE
Concrete, audit-trail-quality sentences. Cite the threshold, the standard (ASC 350-40, materiality, etc.), and the useful-life basis. Avoid hedging filler. The CPA should be able to drop your rationale into a workpaper.

You produce a recommendation. A human CPA reviews everything before a FixedAsset row is created or a JE is posted. Be precise; surface your uncertainty.`;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function setClientForTesting(client: Anthropic | null): void {
  _client = client;
}

export async function classifyCapex(
  invoiceText: string
): Promise<ClassificationResult> {
  if (!invoiceText.trim()) {
    throw new Error("invoiceText is empty — nothing to classify");
  }

  const userMessage = [
    `Classify this purchase under the firm's US GAAP capex policy.`,
    ``,
    `--- PURCHASE BEGIN ---`,
    invoiceText,
    `--- PURCHASE END ---`,
  ].join("\n");

  const promptHash = createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update("\n---\n")
    .update(userMessage)
    .digest("hex");

  const startedAt = Date.now();
  const response = await getClient().messages.parse({
    model: CAPEX_CLASSIFIER_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(ClassificationSchema) },
  });
  const latencyMs = Date.now() - startedAt;

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Capex classifier returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  return {
    classification: parsed,
    modelName: CAPEX_CLASSIFIER_MODEL,
    promptHash,
    promptTokens: response.usage?.input_tokens ?? null,
    completionTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    latencyMs,
  };
}
