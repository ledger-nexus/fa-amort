// MACRS depreciation tests.
//
// Verifies the IRS Pub 946 Table A-1 percentages produce the expected
// annual totals + that monthly accrual ties out to the annual figure
// each year (rounding residual absorbed by the year-end month).
//
// Pure functions — no DB, no IO. Tests the math only.

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import { runDepreciation, projectFullSchedule } from "../src/lib/accounting/depreciation";

function totalForYear(periods: ReturnType<typeof projectFullSchedule>, yearIndex: number): Decimal {
  // Year N covers month indexes (N*12) through (N*12 + 11).
  // periods are in order, one per month starting at in-service month 0.
  const start = yearIndex * 12;
  const end = start + 12;
  return periods
    .slice(start, end)
    .reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
}

describe("MACRS_5_HY — 5-year half-year convention", () => {
  // $10,000 cost, placed in service 2026-01-15. 60-month useful life
  // (matches IRS 5-year recovery period). Salvage IGNORED for MACRS.
  const cost = 10_000;
  const periods = projectFullSchedule({
    cost,
    salvageValue: 0,
    usefulLifeMonths: 60,
    inServiceDate: new Date(Date.UTC(2026, 0, 15)),
    depreciationMethod: "MACRS_5_HY",
  });

  it("emits 72 monthly periods (6 calendar years × 12 months)", () => {
    expect(periods).toHaveLength(72);
  });

  it("Year 1 totals $2,000 (20.00% × $10,000)", () => {
    expect(totalForYear(periods, 0).toFixed(2)).toBe("2000.00");
  });

  it("Year 2 totals $3,200 (32.00% × $10,000)", () => {
    expect(totalForYear(periods, 1).toFixed(2)).toBe("3200.00");
  });

  it("Year 3 totals $1,920 (19.20% × $10,000)", () => {
    expect(totalForYear(periods, 2).toFixed(2)).toBe("1920.00");
  });

  it("Year 4 totals $1,152 (11.52% × $10,000)", () => {
    expect(totalForYear(periods, 3).toFixed(2)).toBe("1152.00");
  });

  it("Year 5 totals $1,152 (11.52% × $10,000)", () => {
    expect(totalForYear(periods, 4).toFixed(2)).toBe("1152.00");
  });

  it("Year 6 (half-year stub) totals $576 (5.76% × $10,000)", () => {
    expect(totalForYear(periods, 5).toFixed(2)).toBe("576.00");
  });

  it("cumulative across 72 months equals the full $10,000 cost", () => {
    const total = periods.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
    expect(total.toFixed(2)).toBe("10000.00");
  });

  it("final NBV is zero (MACRS depreciates fully — no salvage)", () => {
    const last = periods[periods.length - 1];
    expect(last.netBookValueAfter.toFixed(2)).toBe("0.00");
  });

  it("Year 1 monthly accruals sum exactly to Year 1 total (rounding residual on month 12)", () => {
    const months = periods.slice(0, 12);
    const sum = months.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
    expect(sum.toFixed(2)).toBe("2000.00");
  });
});

describe("MACRS_3_HY — 3-year half-year convention", () => {
  const cost = 12_000;
  const periods = projectFullSchedule({
    cost,
    salvageValue: 0,
    usefulLifeMonths: 36,
    inServiceDate: new Date(Date.UTC(2026, 0, 15)),
    depreciationMethod: "MACRS_3_HY",
  });

  it("emits 48 monthly periods (4 calendar years)", () => {
    expect(periods).toHaveLength(48);
  });

  it("Year 1 totals $3,999.60 (33.33% × $12,000)", () => {
    expect(totalForYear(periods, 0).toFixed(2)).toBe("3999.60");
  });

  it("Year 4 stub totals $889.20 (7.41% × $12,000)", () => {
    expect(totalForYear(periods, 3).toFixed(2)).toBe("889.20");
  });

  it("cumulative equals 100% × cost (within IRS table precision)", () => {
    const total = periods.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
    // IRS table sums to 100.00% — should tie exactly given proper rounding.
    expect(total.toFixed(2)).toBe("12000.00");
  });
});

describe("MACRS_7_HY — 7-year half-year convention", () => {
  const cost = 7_000;
  const periods = projectFullSchedule({
    cost,
    salvageValue: 0,
    usefulLifeMonths: 84,
    inServiceDate: new Date(Date.UTC(2026, 0, 15)),
    depreciationMethod: "MACRS_7_HY",
  });

  it("emits 96 monthly periods (8 calendar years)", () => {
    expect(periods).toHaveLength(96);
  });

  it("Year 1 totals $1,000.30 (14.29% × $7,000)", () => {
    expect(totalForYear(periods, 0).toFixed(2)).toBe("1000.30");
  });

  it("Year 8 stub totals $312.20 (4.46% × $7,000)", () => {
    expect(totalForYear(periods, 7).toFixed(2)).toBe("312.20");
  });

  it("cumulative equals $7,000", () => {
    const total = periods.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
    expect(total.toFixed(2)).toBe("7000.00");
  });
});

describe("MACRS_15_HY — 15-year half-year convention", () => {
  const cost = 100_000;
  const periods = projectFullSchedule({
    cost,
    salvageValue: 0,
    usefulLifeMonths: 180,
    inServiceDate: new Date(Date.UTC(2026, 0, 15)),
    depreciationMethod: "MACRS_15_HY",
  });

  it("emits 192 monthly periods (16 calendar years)", () => {
    expect(periods).toHaveLength(192);
  });

  it("Year 1 totals $5,000 (5.00% × $100,000)", () => {
    expect(totalForYear(periods, 0).toFixed(2)).toBe("5000.00");
  });

  it("Year 16 stub totals $2,950 (2.95% × $100,000)", () => {
    expect(totalForYear(periods, 15).toFixed(2)).toBe("2950.00");
  });

  it("cumulative equals $100,000", () => {
    const total = periods.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
    expect(total.toFixed(2)).toBe("100000.00");
  });
});

describe("MACRS validation guards", () => {
  it("refuses MACRS_5_HY with usefulLifeMonths != 60", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: new Decimal(10000),
          salvageValue: new Decimal(0),
          usefulLifeMonths: 48, // wrong — should be 60
          inServiceDate: new Date(Date.UTC(2026, 0, 15)),
          depreciationMethod: "MACRS_5_HY",
          accumulatedDepreciation: new Decimal(0),
          lastDepreciatedThrough: null,
        },
        throughDate: new Date(Date.UTC(2026, 1, 28)),
      })
    ).toThrow(/MACRS_5_HY requires usefulLifeMonths=60/);
  });

  it("refuses MACRS_7_HY with usefulLifeMonths=60 (must be 84)", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: new Decimal(10000),
          salvageValue: new Decimal(0),
          usefulLifeMonths: 60,
          inServiceDate: new Date(Date.UTC(2026, 0, 15)),
          depreciationMethod: "MACRS_7_HY",
          accumulatedDepreciation: new Decimal(0),
          lastDepreciatedThrough: null,
        },
        throughDate: new Date(Date.UTC(2026, 1, 28)),
      })
    ).toThrow(/MACRS_7_HY requires usefulLifeMonths=84/);
  });
});

describe("MACRS resume from accumulatedDepreciation", () => {
  // Resume case: an asset that's been depreciating since 2026-01 and
  // has been booked through 2026-12-31 (12 months → Year 1 complete).
  // Running again through 2027-06-30 should book exactly 6 months of
  // Year 2 expense.
  it("emits exactly months 13..18 (Year 2 first half) when resuming after Year 1 complete", () => {
    const cost = new Decimal(10_000);
    const year1Total = cost.times(0.20); // $2,000

    const result = runDepreciation({
      asset: {
        cost,
        salvageValue: new Decimal(0),
        usefulLifeMonths: 60,
        inServiceDate: new Date(Date.UTC(2026, 0, 15)),
        depreciationMethod: "MACRS_5_HY",
        accumulatedDepreciation: year1Total,
        lastDepreciatedThrough: new Date(Date.UTC(2026, 11, 31)),
      },
      throughDate: new Date(Date.UTC(2027, 5, 30)),
    });

    expect(result.periods).toHaveLength(6);
    // 6 months × ($3,200 / 12 = $266.67 each, with rounding) ≈ $1,600
    const sixMonthTotal = result.periods.reduce(
      (acc, p) => acc.plus(p.expenseAmount),
      new Decimal(0)
    );
    // 6/12 of Year 2's $3,200 = $1,600. Allow slight rounding within
    // a year (the Year-12 residual lands in month 12, not visible here).
    expect(Number(sixMonthTotal.toFixed(2))).toBeCloseTo(1600, 0);
  });
});
