// Tests for the resume-from-history helper.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { computeResumeFromHistory } from "../src/lib/mappers/netsuite/resume-from-history";

describe("computeResumeFromHistory — STRAIGHT_LINE happy paths", () => {
  it("returns null with reason when accumulated is 0 (start fresh)", () => {
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 0,
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.monthsElapsed).toBe(0);
    expect(r.reason).toMatch(/accumulated_depreciation is 0/);
  });

  it("computes 18 months elapsed for $10k cost, $1k salvage, 36-month life, $4500 accumulated", () => {
    // monthlyExpense = (10000-1000)/36 = 250
    // monthsElapsed = 4500/250 = 18
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)), // 2024-01-01
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 4500,
    });
    expect(r.monthsElapsed).toBe(18);
    // 2024-01 + 18 periods - 1 = 2025-06 → end of June 2025 = 2025-06-30
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2025-06-30"
    );
  });

  it("computes 1 period elapsed for the first month's expense", () => {
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 250,
    });
    expect(r.monthsElapsed).toBe(1);
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2024-01-31"
    );
  });

  it("clamps to usefulLifeMonths when accumulated exceeds depreciable base", () => {
    // base = 9000, monthly = 250 — accumulated 99,999 would imply
    // hundreds of months; clamp to 36.
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 99999,
    });
    expect(r.monthsElapsed).toBe(36);
    // 2024-01 + 36 - 1 = 2026-12 → 2026-12-31
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2026-12-31"
    );
  });

  it("rounds to nearest integer months (uses round-half-even semantics)", () => {
    // accumulated = 380; monthly = 250 → 380/250 = 1.52 → rounds to 2
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 380,
    });
    expect(r.monthsElapsed).toBe(2);
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2024-02-29" // leap year
    );
  });
});

describe("computeResumeFromHistory — STRAIGHT_LINE edge cases", () => {
  it("returns null with reason when rounded monthsElapsed = 0 (sub-period accumulated)", () => {
    // accumulated = 50, monthly = 250 → 0.2 rounds to 0
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 50,
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.monthsElapsed).toBe(0);
    expect(r.reason).toMatch(/monthsElapsed = 0/);
  });

  it("returns null for usefulLifeMonths = 0", () => {
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 0,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 4500,
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/usefulLifeMonths/);
  });

  it("returns null for salvage >= cost (no depreciable base)", () => {
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 1000,
      salvageValue: 1500,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 4500,
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/depreciable base/);
  });

  it("wraps across multiple years correctly", () => {
    // 30 months from Jan 2024 → Jun 2026 ends month index 24+5=29 → year 2026, month 5 (June 0-indexed = July in display? let me recheck)
    // monthsElapsed=30, inServiceMonth=0 (Jan); lastIdx = 0+30-1 = 29
    // year increment = floor(29/12) = 2, month = 29 % 12 = 5 (June 0-indexed)
    // endOfMonth(2026, 5) = June 30, 2026
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 7500, // 7500/250 = 30 months
    });
    expect(r.monthsElapsed).toBe(30);
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2026-06-30"
    );
  });

  it("handles mid-year inServiceDate correctly", () => {
    // inServiceDate = 2024-04-01, monthsElapsed = 12 → last period ends 2025-03-31
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 3, 1)), // April
      acquisitionCost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: 3000, // 3000/250 = 12 months
    });
    expect(r.monthsElapsed).toBe(12);
    expect(r.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2025-03-31"
    );
  });
});

describe("computeResumeFromHistory — non-STRAIGHT_LINE methods", () => {
  const baseInput = {
    inServiceDate: new Date(Date.UTC(2024, 0, 1)),
    acquisitionCost: 10000,
    salvageValue: 1000,
    usefulLifeMonths: 36,
    accumulatedDepreciation: 4500,
  };

  it("returns null with reason for DOUBLE_DECLINING (non-linear)", () => {
    const r = computeResumeFromHistory({
      ...baseInput,
      depreciationMethod: "DOUBLE_DECLINING",
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/DOUBLE_DECLINING/);
    expect(r.reason).toMatch(/non-linear/);
  });

  it("returns null with reason for MACRS_5_HY (non-linear)", () => {
    const r = computeResumeFromHistory({
      ...baseInput,
      depreciationMethod: "MACRS_5_HY",
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/MACRS_5_HY/);
  });

  it("returns null with reason for UNITS_OF_PRODUCTION (no calendar)", () => {
    const r = computeResumeFromHistory({
      ...baseInput,
      depreciationMethod: "UNITS_OF_PRODUCTION",
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/UNITS_OF_PRODUCTION/);
  });

  it("returns null with reason for NONE (no depreciation)", () => {
    const r = computeResumeFromHistory({
      ...baseInput,
      depreciationMethod: "NONE",
    });
    expect(r.lastDepreciatedThrough).toBeNull();
    expect(r.reason).toMatch(/NONE/);
  });
});

describe("computeResumeFromHistory — accepts Decimal inputs", () => {
  it("works with Decimal acquisitionCost", () => {
    const r = computeResumeFromHistory({
      inServiceDate: new Date(Date.UTC(2024, 0, 1)),
      acquisitionCost: new Decimal("10000.00"),
      salvageValue: new Decimal("1000.00"),
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: new Decimal("4500.00"),
    });
    expect(r.monthsElapsed).toBe(18);
  });

  it("works with string inputs (Prisma's Decimal serialization)", () => {
    const r = computeResumeFromHistory({
      inServiceDate: "2024-01-01",
      acquisitionCost: "10000",
      salvageValue: "1000",
      usefulLifeMonths: 36,
      depreciationMethod: "STRAIGHT_LINE",
      accumulatedDepreciation: "4500",
    });
    expect(r.monthsElapsed).toBe(18);
  });
});
