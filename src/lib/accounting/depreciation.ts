// Depreciation math.
//
// Pure functions. Given an asset's cost, salvage, useful-life-months,
// in-service date, depreciation method, and a date range, compute the
// expense to recognize for that range. The caller posts the resulting
// JE through the ledger-core HTTP bridge.
//
// v0.1 supports:
//   STRAIGHT_LINE       — (cost - salvage) / months, evenly per month
//   DOUBLE_DECLINING    — 2 × (1 / months) of remaining NBV each month;
//                         floors at salvage value
//   NONE                — non-depreciable (land); always returns zero
//
// v0.2 will add MACRS tables (3, 5, 7, 15-year half-year convention) for
// US tax depreciation. MACRS isn't math — it's lookup tables from IRS
// Publication 946. Best to ship the methods accountants need most first.
//
// All math uses Decimal.js. Penny-perfect: the engine tracks cumulative
// depreciation and on the LAST period before fully depreciated, the
// expense for that month equals (cost - salvage - cumulative_so_far)
// to eliminate any rounding residual. Mirrors revenue-rec's schedule
// generator pattern.

import { Decimal } from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type DepreciationMethod =
  | "STRAIGHT_LINE"
  | "DOUBLE_DECLINING"
  | "MACRS_3_HY"
  | "MACRS_5_HY"
  | "MACRS_7_HY"
  | "MACRS_15_HY"
  | "UNITS_OF_PRODUCTION"
  | "NONE";

export class DepreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepreciationError";
  }
}

export interface AssetSpec {
  cost: Decimal | string | number;
  salvageValue: Decimal | string | number;
  usefulLifeMonths: number;
  inServiceDate: Date;
  depreciationMethod: DepreciationMethod;
  /** Cumulative depreciation already booked (from prior runs). */
  accumulatedDepreciation: Decimal | string | number;
  /**
   * The last date depreciation was run through. If null, the asset has
   * never depreciated — the first run starts from inServiceDate.
   */
  lastDepreciatedThrough?: Date | null;
}

export interface SchedulePeriod {
  /** First day of the calendar month. */
  periodStart: Date;
  /** Last day of the calendar month. */
  periodEnd: Date;
  /** Depreciation expense for this period (always non-negative). */
  expenseAmount: Decimal;
  /** Cumulative depreciation through the end of this period. */
  cumulativeAfter: Decimal;
  /** Net book value at the end of this period (cost - cumulative). */
  netBookValueAfter: Decimal;
}

export interface RunDepreciationInput {
  asset: AssetSpec;
  /**
   * Compute expense up to and including this date. Typically a
   * month-end, but the schedule output is still per-calendar-month —
   * a mid-month "through" date produces the same result as the
   * preceding month-end (no partial-month proration in v0.1).
   */
  throughDate: Date;
}

export interface RunDepreciationResult {
  /** Periods to book this run. Empty if nothing's due. */
  periods: SchedulePeriod[];
  /** Sum of expenseAmount across periods. */
  totalExpense: Decimal;
  /** New cumulativeAfter after the last period, or unchanged accum if no periods. */
  cumulativeAfter: Decimal;
  /** New lastDepreciatedThrough — the periodEnd of the last booked period, or null if no periods. */
  newLastDepreciatedThrough: Date | null;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function toDecimal(v: Decimal | string | number): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}

function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function addMonthsUTC(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}

// ─── Per-period expense calculation ────────────────────────────────────────

/**
 * Compute the per-period expense for STRAIGHT_LINE on a particular month
 * index (0-based, counting from inServiceDate). Each month gets an equal
 * share; the LAST month absorbs the rounding residual so cumulative ties
 * exactly to depreciable base.
 */
function straightLineExpense(
  monthIndex: number,
  totalMonths: number,
  depreciableBase: Decimal
): Decimal {
  if (monthIndex >= totalMonths) return new Decimal(0);
  const perPeriod = depreciableBase
    .dividedBy(totalMonths)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  if (monthIndex === totalMonths - 1) {
    // Last month: depreciableBase minus everything booked previously.
    const bookedThroughLast = perPeriod.times(totalMonths - 1);
    return depreciableBase.minus(bookedThroughLast);
  }
  return perPeriod;
}

/**
 * Compute the per-period expense for DOUBLE_DECLINING with the
 * **straight-line crossover convention** on a particular month index.
 *
 * Mechanics:
 *
 *   1. The DDB candidate is `nbvBefore × 2 / totalMonths`.
 *   2. The SL crossover candidate is the constant amount needed to
 *      fully depreciate the remaining `(nbv - salvage)` over the
 *      remaining months: `(nbvBefore - salvage) / monthsRemaining`.
 *   3. We take the larger of the two each month. This produces the
 *      standard IRS convention: pure DDB early, then a clean switch to
 *      SL once SL would book more (because SL becomes monotonically
 *      ≥ DDB once you cross it, the per-month max picks SL forever
 *      after — same trajectory as a one-time switch).
 *   4. The hard salvage floor still applies: cumulative depreciation
 *      can never exceed `cost - salvage`.
 *   5. The final month absorbs whatever rounding residual remains so
 *      the cumulative ties exactly to `(cost - salvage)`. Mirrors the
 *      straight-line "last period absorbs" policy.
 *
 * Why the max(DDB, SL) form rather than tracking a "have we crossed
 * yet" boolean: it's stateless, makes a re-run from any month
 * idempotent, and is the same shape MACRS half-year tables encode.
 */
function doubleDecliningExpense(
  monthIndex: number,
  totalMonths: number,
  cost: Decimal,
  salvageValue: Decimal,
  cumulativeBeforeThisMonth: Decimal
): Decimal {
  if (monthIndex >= totalMonths) return new Decimal(0);
  const nbvBefore = cost.minus(cumulativeBeforeThisMonth);
  const maxAllowedCumulative = cost.minus(salvageValue);
  const remainingDepreciable = maxAllowedCumulative.minus(cumulativeBeforeThisMonth);

  // Final month: book whatever is needed to tie cumulative to
  // (cost - salvage). Same residual-absorption rule as straight-line.
  // Without this, DDB rounding could leave a fraction-of-a-cent on the
  // table at end of life.
  if (monthIndex === totalMonths - 1) {
    return remainingDepreciable.isNegative()
      ? new Decimal(0)
      : remainingDepreciable;
  }

  // DDB candidate.
  const rate = new Decimal(2).dividedBy(totalMonths);
  const ddbCandidate = nbvBefore
    .times(rate)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  // Straight-line crossover candidate: the constant amount that would
  // exhaust the remaining depreciable base over the remaining months
  // if we switched to SL right now.
  const monthsRemaining = totalMonths - monthIndex;
  const slCandidate =
    monthsRemaining > 0
      ? remainingDepreciable
          .dividedBy(monthsRemaining)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
      : new Decimal(0);

  // Take whichever produces the larger deduction. Once SL > DDB it
  // stays that way (NBV keeps falling, monthsRemaining keeps shrinking
  // faster than NBV under SL), so the per-month max is equivalent to
  // a one-time switch.
  let expense = ddbCandidate.greaterThanOrEqualTo(slCandidate)
    ? ddbCandidate
    : slCandidate;

  // Hard salvage floor.
  if (expense.greaterThan(remainingDepreciable)) {
    expense = remainingDepreciable;
  }
  if (expense.isNegative()) expense = new Decimal(0);
  return expense;
}

// ─── MACRS (Modified Accelerated Cost Recovery System) ───────────────────
//
// MACRS is the US tax depreciation method for property placed in service
// after 1986. The percentages below come from IRS Publication 946,
// Table A-1 (200% declining balance, half-year convention). These tables
// already bake in:
//
//   - 200% declining balance for the first N-1 years (or N for 15-year)
//   - Switch to straight-line when SL would produce a larger deduction
//   - Half-year convention (Year 1 gets a half-year's worth of dep,
//     so the asset's recovery period spans N+1 calendar years for an
//     N-year asset)
//
// For book-monthly closes we divide each year's annual percentage by 12.
// Tax filers report MACRS annually (Form 4562); the monthly recognition
// is a book-only approximation that ties out to the same annual total.
//
// recovery period (years) → array of annual percentages (one per
// calendar year the property is depreciated in, including the half-year
// stub in Year 1 + Year N+1).
//
// Source: IRS Pub 946 (2023 edition), Table A-1.
const MACRS_HY_TABLE: Record<3 | 5 | 7 | 15, ReadonlyArray<number>> = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20.00, 32.00, 19.20, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  15: [
    5.00, 9.50, 8.55, 7.70, 6.93, 6.23, 5.90, 5.90, 5.91, 5.90, 5.91, 5.90,
    5.91, 5.90, 5.91, 2.95,
  ],
};

function macrsRecoveryYears(method: DepreciationMethod): 3 | 5 | 7 | 15 {
  switch (method) {
    case "MACRS_3_HY":  return 3;
    case "MACRS_5_HY":  return 5;
    case "MACRS_7_HY":  return 7;
    case "MACRS_15_HY": return 15;
    default:
      throw new DepreciationError(`Not a MACRS method: ${method}`);
  }
}

/**
 * Compute the per-month MACRS expense for a given month index.
 *
 * monthIndex is 0-based from in-service date. We translate to a "tax
 * year index" (0-based): years 0..N correspond to the rows of the
 * MACRS table. Year 0 gets the half-year-convention small first row
 * spread across 12 months (so Jan = Year-1-percentage / 12, regardless
 * of when in the calendar year the asset was placed in service).
 *
 * Salvage value is IGNORED on purpose — MACRS does not use a salvage
 * value (the table already drives the asset to zero cumulative
 * depreciation, matching tax practice).
 *
 * Rounding: each month gets annualPct% / 12 of cost, rounded to 2dp.
 * The LAST month of each tax year absorbs that year's rounding
 * residual so the year totals exactly to annualPct% of cost.
 */
function macrsExpense(
  monthIndex: number,
  method: DepreciationMethod,
  cost: Decimal
): Decimal {
  const recoveryYears = macrsRecoveryYears(method);
  const table = MACRS_HY_TABLE[recoveryYears];

  // Tax year (0-based) this month falls into. A 5-year asset has
  // 6 tax years' worth of percentages (Years 1..6); month indexes
  // 0..71 map to years 0..5 (12 months each).
  const taxYearIndex = Math.floor(monthIndex / 12);
  if (taxYearIndex >= table.length) {
    // Past the recovery period — fully depreciated.
    return new Decimal(0);
  }

  const annualPct = new Decimal(table[taxYearIndex]);
  const annualAmount = cost
    .times(annualPct)
    .dividedBy(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  // Within-year month (0..11).
  const monthOfYear = monthIndex % 12;

  if (monthOfYear < 11) {
    // Months 0..10: even share. Floor-rounded so the year-end month
    // can absorb residual.
    return annualAmount
      .dividedBy(12)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  }

  // Month 11 (year-end): absorb residual so the 12-month sum equals
  // annualAmount exactly.
  const monthly = annualAmount
    .dividedBy(12)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  const elevenMonths = monthly.times(11);
  return annualAmount.minus(elevenMonths);
}

function isMacrsMethod(m: DepreciationMethod): boolean {
  return (
    m === "MACRS_3_HY" ||
    m === "MACRS_5_HY" ||
    m === "MACRS_7_HY" ||
    m === "MACRS_15_HY"
  );
}

// ─── Main scheduler ────────────────────────────────────────────────────────

/**
 * Given an asset's state and a "through" date, compute the periods to
 * book on this run. Handles the resume case: if the asset has been
 * depreciated through some prior date, only periods after that are
 * returned.
 */
export function runDepreciation(input: RunDepreciationInput): RunDepreciationResult {
  const { asset, throughDate } = input;
  const cost = toDecimal(asset.cost);
  const salvage = toDecimal(asset.salvageValue);
  let cumulative = toDecimal(asset.accumulatedDepreciation);

  if (asset.depreciationMethod === "NONE") {
    return {
      periods: [],
      totalExpense: new Decimal(0),
      cumulativeAfter: cumulative,
      newLastDepreciatedThrough: null,
    };
  }

  if (
    asset.depreciationMethod !== "STRAIGHT_LINE" &&
    asset.depreciationMethod !== "DOUBLE_DECLINING" &&
    !isMacrsMethod(asset.depreciationMethod)
  ) {
    throw new DepreciationError(
      `Depreciation method ${asset.depreciationMethod} is not supported yet (units-of-production lands later)`
    );
  }

  if (asset.usefulLifeMonths <= 0) {
    throw new DepreciationError(
      `usefulLifeMonths must be positive (got ${asset.usefulLifeMonths})`
    );
  }
  if (cost.isNegative() || salvage.isNegative()) {
    throw new DepreciationError("cost and salvageValue must be non-negative");
  }
  if (salvage.greaterThan(cost)) {
    throw new DepreciationError("salvageValue cannot exceed cost");
  }

  // MACRS validation: usefulLifeMonths must match the method's
  // recovery period × 12. The IRS table is keyed on recovery period,
  // not the asset's free-form life setting.
  if (isMacrsMethod(asset.depreciationMethod)) {
    const recoveryYears = macrsRecoveryYears(asset.depreciationMethod);
    const expectedMonths = recoveryYears * 12;
    if (asset.usefulLifeMonths !== expectedMonths) {
      throw new DepreciationError(
        `${asset.depreciationMethod} requires usefulLifeMonths=${expectedMonths} (got ${asset.usefulLifeMonths}). MACRS is keyed on the recovery period in IRS Pub 946, not a free-form life.`
      );
    }
  }

  const inService = startOfMonthUTC(asset.inServiceDate);
  // Earliest unbooked month: month AFTER lastDepreciatedThrough, or the
  // in-service month if we've never run before. Anchor at the 1st of the
  // month FIRST, then add — otherwise Jan 31 + 1 month overflows to March 3
  // (Feb has 28 days), skipping February entirely.
  const startMonth = asset.lastDepreciatedThrough
    ? addMonthsUTC(startOfMonthUTC(asset.lastDepreciatedThrough), 1)
    : inService;
  const lastMonth = startOfMonthUTC(throughDate);

  if (lastMonth < startMonth) {
    // Nothing due (throughDate is before the next period).
    return {
      periods: [],
      totalExpense: new Decimal(0),
      cumulativeAfter: cumulative,
      newLastDepreciatedThrough: asset.lastDepreciatedThrough ?? null,
    };
  }

  const depreciableBase = cost.minus(salvage);
  const periods: SchedulePeriod[] = [];

  // Walk month-by-month from startMonth through lastMonth.
  let month = startMonth;
  while (month <= lastMonth) {
    // Months since in-service (0-based). The asset's life is
    // usefulLifeMonths counting from inServiceDate.
    const monthIndex =
      (month.getUTCFullYear() - inService.getUTCFullYear()) * 12 +
      (month.getUTCMonth() - inService.getUTCMonth());

    if (monthIndex < 0) {
      // Shouldn't happen given startMonth ≥ inService, but defensive.
      month = addMonthsUTC(month, 1);
      continue;
    }

    let expense: Decimal;
    if (asset.depreciationMethod === "STRAIGHT_LINE") {
      expense = straightLineExpense(monthIndex, asset.usefulLifeMonths, depreciableBase);
    } else if (asset.depreciationMethod === "DOUBLE_DECLINING") {
      expense = doubleDecliningExpense(
        monthIndex,
        asset.usefulLifeMonths,
        cost,
        salvage,
        cumulative
      );
    } else {
      // MACRS_*_HY — no salvage value in MACRS; cost is the basis.
      // MACRS recovery period spans MORE than usefulLifeMonths because
      // of the half-year convention's trailing stub (e.g. 5-year
      // recovery = 6 calendar years = 72 months). Walk past
      // usefulLifeMonths up to the end of the table.
      expense = macrsExpense(monthIndex, asset.depreciationMethod, cost);
    }

    cumulative = cumulative.plus(expense);
    periods.push({
      periodStart: startOfMonthUTC(month),
      periodEnd: endOfMonthUTC(month),
      expenseAmount: expense,
      cumulativeAfter: cumulative,
      netBookValueAfter: cost.minus(cumulative),
    });

    month = addMonthsUTC(month, 1);
  }

  const totalExpense = periods.reduce((acc, p) => acc.plus(p.expenseAmount), new Decimal(0));
  const newLastDepreciatedThrough =
    periods.length > 0 ? periods[periods.length - 1].periodEnd : asset.lastDepreciatedThrough ?? null;

  return {
    periods,
    totalExpense,
    cumulativeAfter: cumulative,
    newLastDepreciatedThrough,
  };
}

/**
 * Convenience: emit the full schedule (no asset state needed beyond the
 * initial cost / salvage / life / method). Used by the UI to render
 * a forward-looking table of "if you depreciate this asset, here's what
 * happens." Doesn't consider any prior depreciation runs.
 */
export function projectFullSchedule(input: {
  cost: Decimal | string | number;
  salvageValue: Decimal | string | number;
  usefulLifeMonths: number;
  inServiceDate: Date;
  depreciationMethod: DepreciationMethod;
}): SchedulePeriod[] {
  if (input.depreciationMethod === "NONE") return [];

  const cost = toDecimal(input.cost);
  const salvage = toDecimal(input.salvageValue);
  // MACRS recovery period spans MORE than usefulLifeMonths because of
  // the half-year-convention trailing stub (e.g. 5-year MACRS = 6
  // calendar years of recovery = 72 months, while usefulLifeMonths=60).
  // For MACRS methods, walk to the end of the table; for SL/DDB, the
  // last month is usefulLifeMonths - 1.
  const isMacrs = isMacrsMethod(input.depreciationMethod);
  const totalMonths = isMacrs
    ? MACRS_HY_TABLE[macrsRecoveryYears(input.depreciationMethod)].length * 12
    : input.usefulLifeMonths;
  const finalMonth = addMonthsUTC(
    startOfMonthUTC(input.inServiceDate),
    totalMonths - 1
  );
  const result = runDepreciation({
    asset: {
      cost,
      salvageValue: salvage,
      usefulLifeMonths: input.usefulLifeMonths,
      inServiceDate: input.inServiceDate,
      depreciationMethod: input.depreciationMethod,
      accumulatedDepreciation: 0,
      lastDepreciatedThrough: null,
    },
    throughDate: endOfMonthUTC(finalMonth),
  });
  return result.periods;
}
