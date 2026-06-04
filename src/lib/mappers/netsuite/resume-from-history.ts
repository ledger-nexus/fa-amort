// Resume-from-history helper for NetSuite-imported fixed assets.
//
// After importNsFixedAssets writes an asset with the NetSuite-reported
// accumulated_depreciation onto its bookAttributes row,
// `lastDepreciatedThrough` is still null — the runDepreciation engine
// would replay from inServiceDate forward, double-counting the
// historical depreciation NetSuite already booked.
//
// This helper computes the correct `lastDepreciatedThrough` so the
// engine resumes from where NetSuite left off, posting only NEW JEs
// from the next month onward.
//
// Supported methods today:
//   STRAIGHT_LINE — accumulated / monthlyExpense = months_elapsed
//
// Unsupported (returns null + a reason):
//   DOUBLE_DECLINING / MACRS_* — non-linear schedules; backsolving
//     from accumulated requires the full per-month rate table.
//     Caller can manually run depreciation period-by-period if needed.
//   UNITS_OF_PRODUCTION — driven by units, not time; no calendar
//     resume.
//   NONE — asset isn't being depreciated; resume is meaningless.

import { Decimal } from "decimal.js";

export interface ResumeFromHistoryInput {
  inServiceDate: Date | string;
  acquisitionCost: Decimal | string | number;
  salvageValue: Decimal | string | number;
  usefulLifeMonths: number;
  depreciationMethod:
    | "STRAIGHT_LINE"
    | "DOUBLE_DECLINING"
    | "MACRS_3_HY"
    | "MACRS_5_HY"
    | "MACRS_7_HY"
    | "MACRS_15_HY"
    | "UNITS_OF_PRODUCTION"
    | "NONE";
  accumulatedDepreciation: Decimal | string | number;
}

export interface ResumeFromHistoryResult {
  /**
   * The computed last-depreciated-through date, or null if resume
   * isn't supported for the given method / inputs.
   */
  lastDepreciatedThrough: Date | null;
  /**
   * Number of months elapsed (months already booked at NetSuite).
   * 0 if accumulated == 0; null when lastDepreciatedThrough is null.
   */
  monthsElapsed: number | null;
  /**
   * Why lastDepreciatedThrough was null, if applicable. Useful for
   * surfacing warnings in import results.
   */
  reason?: string;
}

function toDec(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

function endOfMonth(year: number, monthZeroBased: number): Date {
  // monthZeroBased: 0=Jan, 11=Dec. The 0-th day of next month = last day this month.
  return new Date(Date.UTC(year, monthZeroBased + 1, 0));
}

/**
 * Compute the `lastDepreciatedThrough` date that brings the asset's
 * depreciation state into sync with NetSuite's reported accumulated.
 *
 * For STRAIGHT_LINE:
 *   monthlyExpense = (cost - salvage) / usefulLifeMonths
 *   monthsElapsed  = round(accumulated / monthlyExpense)
 *   lastDepThru    = endOfMonth(inServiceDate + monthsElapsed - 1)
 *
 * Rationale: `runDepreciation` treats periods as full calendar months
 * with periodEnd = last day of the month. To resume cleanly from
 * NetSuite's mid-life state, we set lastDepreciatedThrough to the
 * end of the month corresponding to monthsElapsed periods after
 * inServiceDate. The engine's next run will start at the first day
 * of the FOLLOWING month.
 *
 * Caveats:
 *   - If accumulated > total depreciable base, monthsElapsed is
 *     clamped to usefulLifeMonths.
 *   - If monthly expense rounds to 0 (e.g., very small cost / very
 *     long life), this returns null with a "monthly expense zero" reason.
 */
export function computeResumeFromHistory(
  input: ResumeFromHistoryInput
): ResumeFromHistoryResult {
  const accumulated = toDec(input.accumulatedDepreciation);

  if (accumulated.eq(0)) {
    return {
      lastDepreciatedThrough: null,
      monthsElapsed: 0,
      reason: "accumulated_depreciation is 0 — engine will start from inServiceDate",
    };
  }

  switch (input.depreciationMethod) {
    case "NONE":
      return {
        lastDepreciatedThrough: null,
        monthsElapsed: null,
        reason: "depreciationMethod=NONE — no depreciation to resume",
      };
    case "DOUBLE_DECLINING":
    case "MACRS_3_HY":
    case "MACRS_5_HY":
    case "MACRS_7_HY":
    case "MACRS_15_HY":
      return {
        lastDepreciatedThrough: null,
        monthsElapsed: null,
        reason: `depreciationMethod=${input.depreciationMethod} — non-linear schedule; resume-from-history is STRAIGHT_LINE only. Manually advance lastDepreciatedThrough or re-run from inServiceDate with adjusting JE.`,
      };
    case "UNITS_OF_PRODUCTION":
      return {
        lastDepreciatedThrough: null,
        monthsElapsed: null,
        reason: "depreciationMethod=UNITS_OF_PRODUCTION — driven by units, no calendar resume",
      };
    case "STRAIGHT_LINE":
      break; // continue below
  }

  // STRAIGHT_LINE
  const cost = toDec(input.acquisitionCost);
  const salvage = toDec(input.salvageValue);
  const depreciableBase = cost.minus(salvage);
  const life = input.usefulLifeMonths;

  if (life <= 0) {
    return {
      lastDepreciatedThrough: null,
      monthsElapsed: null,
      reason: "usefulLifeMonths <= 0 — invalid input",
    };
  }
  if (depreciableBase.lte(0)) {
    return {
      lastDepreciatedThrough: null,
      monthsElapsed: null,
      reason: "depreciable base (cost - salvage) <= 0 — invalid input",
    };
  }

  const monthlyExpense = depreciableBase.dividedBy(life);
  if (monthlyExpense.eq(0)) {
    return {
      lastDepreciatedThrough: null,
      monthsElapsed: null,
      reason: "computed monthly expense is 0 — cannot derive months elapsed",
    };
  }

  // Round half-even to match the engine's own rounding behavior.
  const monthsExact = accumulated.dividedBy(monthlyExpense);
  let monthsElapsed = Math.round(monthsExact.toNumber());

  // Clamp to useful life (NetSuite occasionally over-accumulates due
  // to manual adjustments).
  if (monthsElapsed > life) monthsElapsed = life;
  if (monthsElapsed < 0) monthsElapsed = 0;

  if (monthsElapsed === 0) {
    return {
      lastDepreciatedThrough: null,
      monthsElapsed: 0,
      reason:
        "rounded monthsElapsed = 0 despite non-zero accumulated — engine will start from inServiceDate",
    };
  }

  // Anchor at the 1st of the inServiceDate's month, advance monthsElapsed-1
  // months (because we want the LAST booked period's end-of-month),
  // then return the end-of-month.
  const ins =
    input.inServiceDate instanceof Date
      ? input.inServiceDate
      : new Date(input.inServiceDate);
  const insYear = ins.getUTCFullYear();
  const insMonth = ins.getUTCMonth(); // 0-based

  // The 1st booked period is the inServiceDate's month. After N periods,
  // the last booked period's end-of-month is at month (insMonth + N - 1).
  const lastBookedMonthIndex = insMonth + monthsElapsed - 1;
  const lastBookedYear = insYear + Math.floor(lastBookedMonthIndex / 12);
  const lastBookedMonth = ((lastBookedMonthIndex % 12) + 12) % 12; // handle wrap

  return {
    lastDepreciatedThrough: endOfMonth(lastBookedYear, lastBookedMonth),
    monthsElapsed,
  };
}
