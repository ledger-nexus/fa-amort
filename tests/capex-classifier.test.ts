// AI capex classifier unit tests. Mocks the Anthropic SDK via
// setClientForTesting so no live API call. Verifies:
//
//   - messages.parse round-trip returns a typed Classification
//   - cache_control wired on the system prefix (high cache hits across
//     many invoice lines is load-bearing for cost)
//   - User message carries the invoice text
//   - Empty input errors out before any SDK call
//   - Missing parsed_output errors out
//   - Cache hit/miss telemetry surfaces

import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyCapex,
  setClientForTesting,
  CAPEX_CLASSIFIER_MODEL,
} from "../src/lib/ai/capex-classifier";

const sampleInvoice =
  "Vendor: Cisco. 4× Catalyst 9300 48-port switches @ $3,500. Total $14,000.";

const sampleClassification = {
  capitalize: true,
  category: "COMPUTER_EQUIPMENT" as const,
  usefulLifeMonths: 60,
  salvageValuePercent: 0,
  recommendedAssetAccountCode: "1500",
  recommendedDepreciationExpenseAccountCode: "8000",
  recommendedAccumDepreciationAccountCode: "1510",
  recommendedExpenseAccountCode: null,
  confidence: 0.95,
  rationale:
    "Network equipment over the $2,500 threshold with multi-year useful life. 5-year life per industry standard. 0% salvage.",
};

function makeMockClient(
  parsedOutput: unknown,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } = {},
  capture: { lastArgs?: Record<string, unknown> } = {}
) {
  return {
    messages: {
      parse: async (args: Record<string, unknown>) => {
        capture.lastArgs = args;
        return {
          content: [{ type: "tool_use", input: parsedOutput }],
          parsed_output: parsedOutput,
          stop_reason: "end_turn",
          usage: {
            input_tokens: usage.input_tokens ?? 2500,
            output_tokens: usage.output_tokens ?? 600,
            cache_creation_input_tokens:
              usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 2000,
          },
        };
      },
      create: async () => {
        throw new Error("create() should not be called by classifyCapex");
      },
    },
  } as unknown as Parameters<typeof setClientForTesting>[0];
}

beforeEach(() => {
  setClientForTesting(null);
});

describe("classifyCapex", () => {
  it("parses a valid model response into a typed Classification", async () => {
    setClientForTesting(makeMockClient(sampleClassification));
    const r = await classifyCapex(sampleInvoice);
    expect(r.modelName).toBe(CAPEX_CLASSIFIER_MODEL);
    expect(r.classification.capitalize).toBe(true);
    expect(r.classification.category).toBe("COMPUTER_EQUIPMENT");
    expect(r.classification.usefulLifeMonths).toBe(60);
    expect(r.classification.confidence).toBeGreaterThan(0.9);
    expect(r.classification.recommendedAssetAccountCode).toBe("1500");
  });

  it("uses claude-opus-4-7 (not Haiku) — capex is judgment-heavy", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleClassification, {}, capture));
    await classifyCapex(sampleInvoice);
    expect(capture.lastArgs?.model).toBe("claude-opus-4-7");
  });

  it("wraps the system prompt in cache_control: ephemeral", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleClassification, {}, capture));
    await classifyCapex(sampleInvoice);
    const system = capture.lastArgs?.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control?.type).toBe("ephemeral");
    // Sanity: the prompt is the capex policy, not a placeholder.
    expect(system[0].text).toMatch(/CAPITALIZATION THRESHOLD/);
  });

  it("threads the invoice text into the user message", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleClassification, {}, capture));
    await classifyCapex(sampleInvoice);
    const messages = capture.lastArgs?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain(sampleInvoice);
  });

  it("surfaces cache-hit telemetry on the result", async () => {
    setClientForTesting(
      makeMockClient(sampleClassification, {
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_input_tokens: 2700,
        cache_creation_input_tokens: 0,
      })
    );
    const r = await classifyCapex(sampleInvoice);
    expect(r.promptTokens).toBe(3000);
    expect(r.completionTokens).toBe(500);
    expect(r.cacheReadTokens).toBe(2700);
    expect(r.cacheCreationTokens).toBe(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces cache-miss telemetry on the first call (cache_creation > 0)", async () => {
    setClientForTesting(
      makeMockClient(sampleClassification, {
        input_tokens: 3000,
        output_tokens: 500,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 2700,
      })
    );
    const r = await classifyCapex(sampleInvoice);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheCreationTokens).toBe(2700);
  });

  it("handles an EXPENSE classification (capitalize=false, only expense account)", async () => {
    const expenseClassification = {
      capitalize: false,
      category: null,
      usefulLifeMonths: null,
      salvageValuePercent: null,
      recommendedAssetAccountCode: null,
      recommendedDepreciationExpenseAccountCode: null,
      recommendedAccumDepreciationAccountCode: null,
      recommendedExpenseAccountCode: "7000",
      confidence: 0.98,
      rationale: "SaaS subscription. Per ASC 350-40, treated as a service contract — expense as incurred.",
    };
    setClientForTesting(makeMockClient(expenseClassification));
    const r = await classifyCapex("Slack subscription, 50 seats, $7,500/yr");
    expect(r.classification.capitalize).toBe(false);
    expect(r.classification.category).toBeNull();
    expect(r.classification.usefulLifeMonths).toBeNull();
    expect(r.classification.recommendedExpenseAccountCode).toBe("7000");
  });

  it("rejects empty input BEFORE any SDK call", async () => {
    let called = false;
    setClientForTesting({
      messages: {
        parse: async () => {
          called = true;
          // We never reach here for the empty-input case; type doesn't matter.
          return null as never;
        },
        create: async () => {
          throw new Error("nope");
        },
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);
    await expect(classifyCapex("")).rejects.toThrow(/empty/i);
    await expect(classifyCapex("   \n  ")).rejects.toThrow(/empty/i);
    expect(called).toBe(false);
  });

  it("errors when parsed_output is missing (model returned malformed structure)", async () => {
    setClientForTesting({
      messages: {
        parse: async () => ({
          content: [],
          parsed_output: null,
          stop_reason: "max_tokens",
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
        create: async () => {
          throw new Error("nope");
        },
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);
    await expect(classifyCapex(sampleInvoice)).rejects.toThrow(
      /no parsed output/i
    );
  });

  it("promptHash is deterministic across identical inputs (audit replay)", async () => {
    setClientForTesting(makeMockClient(sampleClassification));
    const r1 = await classifyCapex(sampleInvoice);
    const r2 = await classifyCapex(sampleInvoice);
    expect(r1.promptHash).toBe(r2.promptHash);
  });

  it("promptHash differs when the input changes", async () => {
    setClientForTesting(makeMockClient(sampleClassification));
    const r1 = await classifyCapex(sampleInvoice);
    const r2 = await classifyCapex("Different invoice text");
    expect(r1.promptHash).not.toBe(r2.promptHash);
  });
});
