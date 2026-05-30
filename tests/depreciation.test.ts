// Depreciation math tests.
//
// Coverage:
//   - STRAIGHT_LINE: even split, salvage value, rounding residual on last month
//   - DOUBLE_DECLINING: declining rate, hard salvage floor
//   - NONE: returns no periods
//   - MACRS / UNITS_OF_PRODUCTION: throws with v0.2 pointer
//   - Resume from prior accumulated depreciation
//   - projectFullSchedule totals = depreciable base
//   - Input validation (negative cost, salvage > cost, zero life)

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import {
  runDepreciation,
  projectFullSchedule,
  DepreciationError,
} from "../src/lib/accounting/depreciation";

// Helpers --------------------------------------------------------------------

function d(v: string | number): Decimal {
  return new Decimal(v);
}

function utc(y: number, m: number, day = 1): Date {
  return new Date(Date.UTC(y, m - 1, day));
}

function endOfMonth(y: number, m: number): Date {
  return new Date(Date.UTC(y, m, 0));
}

// STRAIGHT_LINE --------------------------------------------------------------

describe("STRAIGHT_LINE", () => {
  it("evenly splits a $12,000 / 12-month asset into $1,000/month", () => {
    const result = runDepreciation({
      asset: {
        cost: 12000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: utc(2026, 12, 31),
    });

    expect(result.periods).toHaveLength(12);
    expect(result.totalExpense.toFixed(2)).toBe("12000.00");
    expect(result.cumulativeAfter.toFixed(2)).toBe("12000.00");
    for (const p of result.periods) {
      expect(p.expenseAmount.toFixed(2)).toBe("1000.00");
    }
  });

  it("absorbs rounding residual on the LAST month (depreciable base 10000/3)", () => {
    // 10000/3 = 3333.333... → 3333.33 per month → last month = 10000 - 6666.66 = 3333.34
    const result = runDepreciation({
      asset: {
        cost: 10000,
        salvageValue: 0,
        usefulLifeMonths: 3,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: utc(2026, 3, 31),
    });

    expect(result.periods).toHaveLength(3);
    expect(result.periods[0].expenseAmount.toFixed(2)).toBe("3333.33");
    expect(result.periods[1].expenseAmount.toFixed(2)).toBe("3333.33");
    expect(result.periods[2].expenseAmount.toFixed(2)).toBe("3333.34");
    // Cumulative ties EXACTLY to depreciable base.
    expect(result.cumulativeAfter.toFixed(2)).toBe("10000.00");
  });

  it("honors salvage value — depreciable base = cost - salvage", () => {
    // $50k cost, $5k salvage, 60 months → $750/mo
    const result = runDepreciation({
      asset: {
        cost: 50000,
        salvageValue: 5000,
        usefulLifeMonths: 60,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: utc(2030, 12, 31),
    });

    expect(result.periods).toHaveLength(60);
    expect(result.totalExpense.toFixed(2)).toBe("45000.00");
    expect(result.cumulativeAfter.toFixed(2)).toBe("45000.00");
    // Net book value at end equals salvage.
    const finalNbv = result.periods[59].netBookValueAfter;
    expect(finalNbv.toFixed(2)).toBe("5000.00");
  });

  it("returns no periods when throughDate is before the in-service month", () => {
    const result = runDepreciation({
      asset: {
        cost: 12000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        inServiceDate: utc(2026, 6, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: utc(2026, 3, 31),
    });
    expect(result.periods).toHaveLength(0);
    expect(result.totalExpense.isZero()).toBe(true);
    expect(result.newLastDepreciatedThrough).toBeNull();
  });

  it("resumes from prior lastDepreciatedThrough (only books new periods)", () => {
    // Asset depreciated through March; ask through May → expect 2 periods (Apr, May).
    const result = runDepreciation({
      asset: {
        cost: 12000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 3000, // 3 months already booked
        lastDepreciatedThrough: endOfMonth(2026, 3),
      },
      throughDate: endOfMonth(2026, 5),
    });

    expect(result.periods).toHaveLength(2);
    expect(result.periods[0].periodStart).toEqual(utc(2026, 4, 1));
    expect(result.periods[1].periodEnd).toEqual(endOfMonth(2026, 5));
    expect(result.totalExpense.toFixed(2)).toBe("2000.00");
    expect(result.cumulativeAfter.toFixed(2)).toBe("5000.00");
    expect(result.newLastDepreciatedThrough).toEqual(endOfMonth(2026, 5));
  });

  it("returns no periods when fully depreciated and asked for another period", () => {
    // 12-month asset fully booked; ask for month 13 → expense 0
    const result = runDepreciation({
      asset: {
        cost: 12000,
        salvageValue: 0,
        usefulLifeMonths: 12,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "STRAIGHT_LINE",
        accumulatedDepreciation: 12000,
        lastDepreciatedThrough: endOfMonth(2026, 12),
      },
      throughDate: endOfMonth(2027, 1),
    });

    // We still produce a "period" for Jan 2027 — but expense is 0 (monthIndex >= totalMonths).
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].expenseAmount.isZero()).toBe(true);
    expect(result.cumulativeAfter.toFixed(2)).toBe("12000.00");
  });
});

// DOUBLE_DECLINING -----------------------------------------------------------

describe("DOUBLE_DECLINING", () => {
  it("applies 2/N rate to net book value each month", () => {
    // 60-month asset → rate = 2/60 ≈ 3.333%/mo on NBV
    const result = runDepreciation({
      asset: {
        cost: 60000,
        salvageValue: 0,
        usefulLifeMonths: 60,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "DOUBLE_DECLINING",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: endOfMonth(2026, 3),
    });

    expect(result.periods).toHaveLength(3);
    // Month 1: 60000 × 2/60 = 2000.00
    expect(result.periods[0].expenseAmount.toFixed(2)).toBe("2000.00");
    // Month 2: (60000 - 2000) × 2/60 = 58000 × 0.0333... = 1933.33
    expect(result.periods[1].expenseAmount.toFixed(2)).toBe("1933.33");
    // Month 3: (60000 - 3933.33) × 2/60 = 56066.67 × 0.0333... = 1868.89
    expect(result.periods[2].expenseAmount.toFixed(2)).toBe("1868.89");
  });

  it("crosses over to straight-line when SL would book more than DDB", () => {
    // 5-month asset, $1000, salvage 0. The crossover bites at month 4:
    //   DDB by month: 400, 240, 144,  86.40,  ...
    //   SL  by month: 200, 150, 120, 108.00, ...
    // At month 4, SL (108) > DDB (86.40) → SL wins. Once SL > DDB it
    // stays that way; cumulative ties cleanly to (cost - salvage).
    const result = runDepreciation({
      asset: {
        cost: 1000,
        salvageValue: 0,
        usefulLifeMonths: 5,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "DOUBLE_DECLINING",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: endOfMonth(2026, 5),
    });

    expect(result.periods).toHaveLength(5);
    expect(result.periods[0].expenseAmount.toFixed(2)).toBe("400.00"); // DDB
    expect(result.periods[1].expenseAmount.toFixed(2)).toBe("240.00"); // DDB
    expect(result.periods[2].expenseAmount.toFixed(2)).toBe("144.00"); // DDB
    expect(result.periods[3].expenseAmount.toFixed(2)).toBe("108.00"); // SL kicks in
    expect(result.periods[4].expenseAmount.toFixed(2)).toBe("108.00"); // last (residual)
    expect(result.cumulativeAfter.toFixed(2)).toBe("1000.00");
  });

  it("fully depreciates a 60-month asset (sum of periods ties to cost - salvage exactly)", () => {
    // Without crossover, pure DDB would leave a long zero tail at the
    // salvage floor; with crossover the schedule fully depreciates by
    // month 60. The last-period residual absorption guarantees the tie
    // even in the presence of half-even rounding drift.
    const result = runDepreciation({
      asset: {
        cost: 60_000,
        salvageValue: 1_000,
        usefulLifeMonths: 60,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "DOUBLE_DECLINING",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: endOfMonth(2030, 12),
    });

    expect(result.periods).toHaveLength(60);
    expect(result.cumulativeAfter.toFixed(2)).toBe("59000.00"); // cost - salvage
    // No zero-expense months along the way (the crossover keeps booking).
    for (let i = 0; i < 60; i++) {
      expect(result.periods[i].expenseAmount.greaterThan(0)).toBe(true);
    }
    // Trajectory sanity: months are non-increasing while on DDB, then
    // FLAT once SL takes over (the SL candidate is recomputed each
    // month but on the SL-dominated tail it lands at the same value
    // ± rounding).
    const m1 = result.periods[0].expenseAmount;
    const m12 = result.periods[11].expenseAmount;
    expect(m1.greaterThan(m12)).toBe(true);
  });

  it("floors at salvage value — cumulative never exceeds (cost - salvage)", () => {
    // Small asset with non-trivial salvage — DDB will hit the floor quickly.
    // Cost 1000, salvage 800, life 12 mo → max depreciable = 200
    const result = runDepreciation({
      asset: {
        cost: 1000,
        salvageValue: 800,
        usefulLifeMonths: 12,
        inServiceDate: utc(2026, 1, 1),
        depreciationMethod: "DOUBLE_DECLINING",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: endOfMonth(2026, 12),
    });

    expect(result.cumulativeAfter.toFixed(2)).toBe("200.00");
    // After the floor is hit, subsequent months should be 0.
    const firstZeroIdx = result.periods.findIndex((p) => p.expenseAmount.isZero());
    expect(firstZeroIdx).toBeGreaterThan(0);
    for (let i = firstZeroIdx; i < result.periods.length; i++) {
      expect(result.periods[i].expenseAmount.toFixed(2)).toBe("0.00");
    }
  });
});

// NONE -----------------------------------------------------------------------

describe("NONE", () => {
  it("returns no periods (e.g., land)", () => {
    const result = runDepreciation({
      asset: {
        cost: 500000,
        salvageValue: 500000,
        usefulLifeMonths: 1, // arbitrary; doesn't matter
        inServiceDate: utc(2020, 1, 1),
        depreciationMethod: "NONE",
        accumulatedDepreciation: 0,
        lastDepreciatedThrough: null,
      },
      throughDate: utc(2030, 12, 31),
    });

    expect(result.periods).toHaveLength(0);
    expect(result.totalExpense.isZero()).toBe(true);
    expect(result.cumulativeAfter.isZero()).toBe(true);
    expect(result.newLastDepreciatedThrough).toBeNull();
  });
});

// Unsupported methods ---------------------------------------------------------
//
// MACRS_*_HY were added; UNITS_OF_PRODUCTION is still future work.
// The previous "all MACRS variants throw" test got rewritten when
// MACRS landed — see tests/macrs.test.ts for the new coverage. This
// block tracks the remaining unsupported methods.

describe("unsupported methods", () => {
  it("UNITS_OF_PRODUCTION throws DepreciationError", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: 10000,
          salvageValue: 0,
          usefulLifeMonths: 36,
          inServiceDate: utc(2026, 1, 1),
          depreciationMethod: "UNITS_OF_PRODUCTION",
          accumulatedDepreciation: 0,
          lastDepreciatedThrough: null,
        },
        throughDate: utc(2026, 12, 31),
      })
    ).toThrow(DepreciationError);
  });
});

// Input validation ----------------------------------------------------------

describe("input validation", () => {
  it("rejects zero useful life", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: 1000,
          salvageValue: 0,
          usefulLifeMonths: 0,
          inServiceDate: utc(2026, 1, 1),
          depreciationMethod: "STRAIGHT_LINE",
          accumulatedDepreciation: 0,
          lastDepreciatedThrough: null,
        },
        throughDate: utc(2026, 12, 31),
      })
    ).toThrow(/usefulLifeMonths/);
  });

  it("rejects negative cost", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: -1000,
          salvageValue: 0,
          usefulLifeMonths: 12,
          inServiceDate: utc(2026, 1, 1),
          depreciationMethod: "STRAIGHT_LINE",
          accumulatedDepreciation: 0,
          lastDepreciatedThrough: null,
        },
        throughDate: utc(2026, 12, 31),
      })
    ).toThrow(/non-negative/);
  });

  it("rejects salvage > cost", () => {
    expect(() =>
      runDepreciation({
        asset: {
          cost: 1000,
          salvageValue: 1500,
          usefulLifeMonths: 12,
          inServiceDate: utc(2026, 1, 1),
          depreciationMethod: "STRAIGHT_LINE",
          accumulatedDepreciation: 0,
          lastDepreciatedThrough: null,
        },
        throughDate: utc(2026, 12, 31),
      })
    ).toThrow(/salvageValue cannot exceed cost/);
  });
});

// projectFullSchedule --------------------------------------------------------

describe("projectFullSchedule", () => {
  it("emits exactly usefulLifeMonths periods", () => {
    const schedule = projectFullSchedule({
      cost: 12000,
      salvageValue: 0,
      usefulLifeMonths: 12,
      inServiceDate: utc(2026, 1, 1),
      depreciationMethod: "STRAIGHT_LINE",
    });
    expect(schedule).toHaveLength(12);
  });

  it("total expense across all periods ties to depreciable base (straight-line)", () => {
    const schedule = projectFullSchedule({
      cost: 50000,
      salvageValue: 5000,
      usefulLifeMonths: 60,
      inServiceDate: utc(2026, 1, 1),
      depreciationMethod: "STRAIGHT_LINE",
    });
    const total = schedule.reduce((acc, p) => acc.plus(p.expenseAmount), d(0));
    expect(total.toFixed(2)).toBe("45000.00");
  });

  it("returns empty schedule for NONE", () => {
    const schedule = projectFullSchedule({
      cost: 500000,
      salvageValue: 500000,
      usefulLifeMonths: 1,
      inServiceDate: utc(2020, 1, 1),
      depreciationMethod: "NONE",
    });
    expect(schedule).toHaveLength(0);
  });

  it("DDB projection floors at salvage", () => {
    const schedule = projectFullSchedule({
      cost: 1000,
      salvageValue: 800,
      usefulLifeMonths: 12,
      inServiceDate: utc(2026, 1, 1),
      depreciationMethod: "DOUBLE_DECLINING",
    });
    const total = schedule.reduce((acc, p) => acc.plus(p.expenseAmount), d(0));
    expect(total.toFixed(2)).toBe("200.00");
  });
});

// Realistic scenario --------------------------------------------------------

describe("realistic accounting scenario", () => {
  it("$72,000 fleet vehicle, 5-year life, $6k salvage, ran monthly for 18 months", () => {
    // Simulate the 'run depreciation' workflow: each month, we ask for
    // periods through that month-end and accumulate state.
    let accumulated = d(0);
    let lastThrough: Date | null = null;
    const allPeriods = [];

    for (let monthOffset = 0; monthOffset < 18; monthOffset++) {
      const year = 2026 + Math.floor(monthOffset / 12);
      const month = (monthOffset % 12) + 1;
      const result = runDepreciation({
        asset: {
          cost: 72000,
          salvageValue: 6000,
          usefulLifeMonths: 60,
          inServiceDate: utc(2026, 1, 1),
          depreciationMethod: "STRAIGHT_LINE",
          accumulatedDepreciation: accumulated,
          lastDepreciatedThrough: lastThrough,
        },
        throughDate: endOfMonth(year, month),
      });
      expect(result.periods).toHaveLength(1);
      accumulated = result.cumulativeAfter;
      lastThrough = result.newLastDepreciatedThrough;
      allPeriods.push(result.periods[0]);
    }

    // 18 months × (72000 - 6000) / 60 = 18 × 1100 = 19800
    expect(accumulated.toFixed(2)).toBe("19800.00");
    expect(allPeriods.every((p) => p.expenseAmount.toFixed(2) === "1100.00")).toBe(true);
  });
});
