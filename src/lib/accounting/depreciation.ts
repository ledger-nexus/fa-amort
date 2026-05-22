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
 * Compute the per-period expense for DOUBLE_DECLINING on a particular
 * month index. The rate is 2 × (1 / totalMonths). Each month applies
 * that rate to the remaining net book value. Floors at salvage:
 * never books below (cost - salvage) cumulative.
 *
 * In practice firms switch from double-declining to straight-line
 * partway through to ensure the asset is fully depreciated by the end
 * of useful life. v0.1 keeps it simple: pure DDB with a hard salvage
 * floor; v0.2 can add the SL crossover.
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
  const rate = new Decimal(2).dividedBy(totalMonths);
  let expense = nbvBefore.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  // Floor at salvage — can never depreciate below (cost - salvage) cumulative.
  const maxAllowedCumulative = cost.minus(salvageValue);
  const remainingDepreciable = maxAllowedCumulative.minus(cumulativeBeforeThisMonth);
  if (expense.greaterThan(remainingDepreciable)) {
    expense = remainingDepreciable;
  }
  if (expense.isNegative()) expense = new Decimal(0);
  return expense;
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
    asset.depreciationMethod !== "DOUBLE_DECLINING"
  ) {
    throw new DepreciationError(
      `Depreciation method ${asset.depreciationMethod} is not supported in v0.1 (MACRS + units-of-production land in v0.2)`
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
    } else {
      // DOUBLE_DECLINING
      expense = doubleDecliningExpense(
        monthIndex,
        asset.usefulLifeMonths,
        cost,
        salvage,
        cumulative
      );
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
  const finalMonth = addMonthsUTC(
    startOfMonthUTC(input.inServiceDate),
    input.usefulLifeMonths - 1
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
