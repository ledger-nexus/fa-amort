// AI impairment-indicator classifier unit tests. Mocks the Anthropic SDK
// via setClientForTesting so no live API call.
//
// Verifies:
//   - messages.parse round-trip returns a typed ImpairmentResponse
//   - System prompt is the actual policy + caching
//   - User message threads the source text through
//   - Empty input rejected before any SDK call
//   - Missing parsed_output errors out
//   - Both "no indicators" and "multiple indicators" responses parse
//     correctly

import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyImpairment,
  setClientForTesting,
  IMPAIRMENT_MODEL,
} from "../src/lib/ai/impairment-classifier";

const sampleNeutralText =
  "Q3 product roadmap update: new mobile app features shipped, customer engagement up 15%, hiring two more engineers.";

const noIndicatorsResponse = {
  hasImpairmentIndicators: false,
  indicators: [],
  overallSeverity: "NONE" as const,
  summaryNote:
    "Reviewed Q3 product roadmap update. No mention of fixed assets, asset categories, market value declines, or operational disruptions. No impairment indicators identified.",
};

const sampleIndicatorText = `Internal memo, dated 2026-08-15:

The board has approved closure of the Atlanta warehouse facility by Q2 2027 in
response to ongoing operational losses. The 50,000 sqft facility, including
leasehold improvements and warehouse machinery installed in 2024, will be
listed for sublease in October. Q3 segment showed our fifth consecutive
quarter of operating losses for the Eastern region.`;

const multiIndicatorResponse = {
  hasImpairmentIndicators: true,
  indicators: [
    {
      affectedCategory: "BUILDINGS_IMPROVEMENTS" as const,
      kind: "EARLY_DISPOSAL" as const,
      severity: "HIGH" as const,
      evidence: "Board approved closure of Atlanta warehouse facility by Q2 2027.",
      rationale:
        "ASC 360-10-35-21(f): expectation that a long-lived asset will be disposed of significantly before the end of its useful life. The 2024-vintage leasehold improvements have substantial remaining useful life that will not be recovered through continued use. Run a recoverability test on Atlanta leasehold improvements this quarter.",
    },
    {
      affectedCategory: "MACHINERY" as const,
      kind: "EARLY_DISPOSAL" as const,
      severity: "HIGH" as const,
      evidence: "Warehouse machinery installed in 2024 ... will be listed for sublease in October.",
      rationale:
        "Same disposal-before-useful-life trigger applies to machinery. The 2024 acquisition date means significant carrying value remains. Subleasing implies the assets stay on our balance sheet — apply ASC 360-10 testing to the asset group.",
    },
    {
      affectedCategory: "BUILDINGS_IMPROVEMENTS" as const,
      kind: "OPERATING_LOSSES" as const,
      severity: "MEDIUM" as const,
      evidence: "Q3 segment showed our fifth consecutive quarter of operating losses for the Eastern region.",
      rationale:
        "ASC 360-10-35-21(d): history of operating losses combined with continuing-loss projection. Compounds the EARLY_DISPOSAL trigger; without the closure plan this would still warrant a recoverability test on its own.",
    },
  ],
  overallSeverity: "HIGH" as const,
  summaryNote:
    "Atlanta warehouse closure plus sustained operating losses constitute clear ASC 360-10 impairment indicators for buildings/leasehold improvements and machinery in the Eastern segment. Run recoverability tests this quarter using undiscounted projected cash flows through the Q2 2027 disposal date.",
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
            input_tokens: usage.input_tokens ?? 3200,
            output_tokens: usage.output_tokens ?? 900,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 2800,
          },
        };
      },
      create: async () => {
        throw new Error("create() should not be called by classifyImpairment");
      },
    },
  } as unknown as Parameters<typeof setClientForTesting>[0];
}

beforeEach(() => {
  setClientForTesting(null);
});

describe("classifyImpairment", () => {
  it("parses a 'no indicators' response correctly", async () => {
    setClientForTesting(makeMockClient(noIndicatorsResponse));
    const r = await classifyImpairment(sampleNeutralText);
    expect(r.modelName).toBe(IMPAIRMENT_MODEL);
    expect(r.response.hasImpairmentIndicators).toBe(false);
    expect(r.response.indicators).toHaveLength(0);
    expect(r.response.overallSeverity).toBe("NONE");
  });

  it("parses multiple indicators into typed array", async () => {
    setClientForTesting(makeMockClient(multiIndicatorResponse));
    const r = await classifyImpairment(sampleIndicatorText);
    expect(r.response.hasImpairmentIndicators).toBe(true);
    expect(r.response.indicators).toHaveLength(3);
    expect(r.response.overallSeverity).toBe("HIGH");
    expect(r.response.indicators[0].affectedCategory).toBe("BUILDINGS_IMPROVEMENTS");
    expect(r.response.indicators[0].kind).toBe("EARLY_DISPOSAL");
    expect(r.response.indicators[0].severity).toBe("HIGH");
  });

  it("uses claude-opus-4-7", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(noIndicatorsResponse, {}, capture));
    await classifyImpairment(sampleNeutralText);
    expect(capture.lastArgs?.model).toBe("claude-opus-4-7");
  });

  it("wraps the system prompt in cache_control: ephemeral", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(makeMockClient(noIndicatorsResponse, {}, capture));
    await classifyImpairment(sampleNeutralText);
    const system = capture.lastArgs?.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(system[0].cache_control?.type).toBe("ephemeral");
    // System prompt is the real ASC 360 policy.
    expect(system[0].text).toMatch(/ASC 360-10/);
  });

  it("threads the source text into the user message", async () => {
    const capture: { lastArgs?: Record<string, unknown> } = {};
    setClientForTesting(
      makeMockClient(multiIndicatorResponse, {}, capture)
    );
    await classifyImpairment(sampleIndicatorText);
    const messages = capture.lastArgs?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].content).toContain("Atlanta warehouse");
    expect(messages[0].content).toContain("Q2 2027");
  });

  it("rejects empty input BEFORE any SDK call", async () => {
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
    await expect(classifyImpairment("")).rejects.toThrow(/empty/i);
    await expect(classifyImpairment("   \n  ")).rejects.toThrow(/empty/i);
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
    await expect(classifyImpairment(sampleIndicatorText)).rejects.toThrow(
      /no parsed output/i
    );
  });

  it("surfaces cache-hit telemetry on the result", async () => {
    setClientForTesting(
      makeMockClient(noIndicatorsResponse, {
        input_tokens: 3500,
        output_tokens: 200,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 0,
      })
    );
    const r = await classifyImpairment(sampleNeutralText);
    expect(r.cacheReadTokens).toBe(3000);
    expect(r.cacheCreationTokens).toBe(0);
    expect(r.promptTokens).toBe(3500);
    expect(r.completionTokens).toBe(200);
  });

  it("promptHash is deterministic across identical inputs", async () => {
    setClientForTesting(makeMockClient(noIndicatorsResponse));
    const r1 = await classifyImpairment(sampleNeutralText);
    const r2 = await classifyImpairment(sampleNeutralText);
    expect(r1.promptHash).toBe(r2.promptHash);
  });
});
