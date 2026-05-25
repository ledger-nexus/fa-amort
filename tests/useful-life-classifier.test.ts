// AI useful-life classifier unit tests. Mocks the Anthropic SDK via
// setClientForTesting so no live API call. Verifies:
//
//   - messages.parse round-trip returns a typed UsefulLifeRecommendation
//   - System prompt is the actual policy (not a placeholder) + caching
//   - User message threads the asset facts in
//   - Empty description rejected before any SDK call
//   - Missing parsed_output errors out
//   - promptHash is deterministic across identical inputs

import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyUsefulLife,
  setClientForTesting,
  USEFUL_LIFE_MODEL,
  type AssetFactSheet,
} from "../src/lib/ai/useful-life-classifier";

const sampleFacts: AssetFactSheet = {
  description: "8 MacBook Pros for engineering team",
  category: "COMPUTER_EQUIPMENT",
  originalUsefulLifeMonths: 36,
  monthsInService: 24,
  bookCode: "US_GAAP",
  conditionNotes: "All units still in active use; no failures.",
};

const sampleRecommendation = {
  recommendedUsefulLifeMonths: 60,
  delta: 24,
  remainingLifeMonths: 36,
  changeKind: "EXTEND" as const,
  triggerType: "MID_LIFE_REVIEW" as const,
  confidence: 0.78,
  rationale:
    "Asset class performing better than initial 36-mo estimate; extending to 60 months aligns with current industry refresh cycle. Per ASC 250-10-45-17 this is a prospective change in estimate — remaining NBV depreciates over 36 more months. Monthly expense decreases starting next period.",
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
            input_tokens: usage.input_tokens ?? 2800,
            output_tokens: usage.output_tokens ?? 700,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 2200,
          },
        };
      },
      create: async () => {
        throw new Error("create() should not be called by classifyUsefulLife");
      },
    },
  } as unknown as Parameters<typeof setClientForTesting>[0];
}

beforeEach(() => {
  setClientForTesting(null);
});

describe("classifyUsefulLife", () => {
  it("parses a valid response into typed UsefulLifeRecommendation", async () => {
    setClientForTesting(makeMockClient(sampleRecommendation));
    const r = await classifyUsefulLife(sampleFacts);
    expect(r.modelName).toBe(USEFUL_LIFE_MODEL);
    expect(r.recommendation.recommendedUsefulLifeMonths).toBe(60);
    expect(r.recommendation.delta).toBe(24);
    expect(r.recommendation.changeKind).toBe("EXTEND");
    expect(r.recommendation.triggerType).toBe("MID_LIFE_REVIEW");
  });

  it("uses claude-opus-4-7", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleRecommendation, {}, capture));
    await classifyUsefulLife(sampleFacts);
    expect(capture.lastArgs?.model).toBe("claude-opus-4-7");
  });

  it("wraps the system prompt in cache_control: ephemeral", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleRecommendation, {}, capture));
    await classifyUsefulLife(sampleFacts);
    const system = capture.lastArgs?.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(system[0].cache_control?.type).toBe("ephemeral");
    // System prompt is the real policy, not a placeholder.
    expect(system[0].text).toMatch(/ASC 250-10-45-17/);
  });

  it("threads the asset facts into the user message", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleRecommendation, {}, capture));
    await classifyUsefulLife(sampleFacts);
    const messages = capture.lastArgs?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].content).toContain("8 MacBook Pros");
    expect(messages[0].content).toContain("36 months");
    expect(messages[0].content).toContain("24");
    expect(messages[0].content).toContain("US_GAAP");
    // conditionNotes only included if non-empty (we provided it).
    expect(messages[0].content).toContain("Condition notes");
  });

  it("omits conditionNotes line when not provided", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(sampleRecommendation, {}, capture));
    const facts: AssetFactSheet = { ...sampleFacts, conditionNotes: undefined };
    await classifyUsefulLife(facts);
    const messages = capture.lastArgs?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].content).not.toContain("Condition notes");
  });

  it("handles a SHORTEN recommendation (vendor EOL trigger)", async () => {
    const shortenRec = {
      recommendedUsefulLifeMonths: 30,
      delta: -6,
      remainingLifeMonths: 6,
      changeKind: "SHORTEN" as const,
      triggerType: "VENDOR_EOL" as const,
      confidence: 0.92,
      rationale:
        "Vendor announced end-of-support 6 months earlier than original useful life. Per ASC 250 prospective rule, remaining NBV depreciates over 6 months.",
    };
    setClientForTesting(makeMockClient(shortenRec));
    const r = await classifyUsefulLife({
      ...sampleFacts,
      externalSignals: "Cisco announced EOL of 9300 series 6 months earlier than expected",
    });
    expect(r.recommendation.changeKind).toBe("SHORTEN");
    expect(r.recommendation.delta).toBe(-6);
    expect(r.recommendation.triggerType).toBe("VENDOR_EOL");
  });

  it("handles a KEEP recommendation (routine review, no change)", async () => {
    const keepRec = {
      recommendedUsefulLifeMonths: 36,
      delta: 0,
      remainingLifeMonths: 12,
      changeKind: "KEEP" as const,
      triggerType: "MID_LIFE_REVIEW" as const,
      confidence: 0.95,
      rationale:
        "Asset performing as expected at midpoint of original life. No trigger to revise. Routine review recommends keeping the 36-month estimate.",
    };
    setClientForTesting(makeMockClient(keepRec));
    const r = await classifyUsefulLife(sampleFacts);
    expect(r.recommendation.changeKind).toBe("KEEP");
    expect(r.recommendation.delta).toBe(0);
  });

  it("surfaces cache-hit telemetry on the result", async () => {
    setClientForTesting(
      makeMockClient(sampleRecommendation, {
        input_tokens: 3000,
        output_tokens: 600,
        cache_read_input_tokens: 2700,
        cache_creation_input_tokens: 0,
      })
    );
    const r = await classifyUsefulLife(sampleFacts);
    expect(r.cacheReadTokens).toBe(2700);
    expect(r.cacheCreationTokens).toBe(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects empty description BEFORE any SDK call", async () => {
    let called = false;
    setClientForTesting({
      messages: {
        parse: async () => {
          called = true;
          return null as never;
        },
        create: async () => {
          throw new Error("nope");
        },
      },
    } as unknown as Parameters<typeof setClientForTesting>[0]);
    await expect(
      classifyUsefulLife({ ...sampleFacts, description: "" })
    ).rejects.toThrow(/empty/i);
    await expect(
      classifyUsefulLife({ ...sampleFacts, description: "  \n  " })
    ).rejects.toThrow(/empty/i);
    expect(called).toBe(false);
  });

  it("errors when parsed_output is missing", async () => {
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
    await expect(classifyUsefulLife(sampleFacts)).rejects.toThrow(
      /no parsed output/i
    );
  });

  it("promptHash is deterministic across identical inputs", async () => {
    setClientForTesting(makeMockClient(sampleRecommendation));
    const r1 = await classifyUsefulLife(sampleFacts);
    const r2 = await classifyUsefulLife(sampleFacts);
    expect(r1.promptHash).toBe(r2.promptHash);
  });

  it("promptHash differs when monthsInService changes", async () => {
    setClientForTesting(makeMockClient(sampleRecommendation));
    const r1 = await classifyUsefulLife(sampleFacts);
    const r2 = await classifyUsefulLife({ ...sampleFacts, monthsInService: 30 });
    expect(r1.promptHash).not.toBe(r2.promptHash);
  });
});
