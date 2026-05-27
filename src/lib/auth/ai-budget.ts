// AI budget enforcement: tenant-level rate limit + monthly spend cap.
//
// Called by every Server Action that hits Anthropic, AFTER
// requireCurrentTenant() returns the tenant. Two checks:
//
//   1. Rate limit (sliding window): cap on AI calls per tenant per
//      hour and per user per minute. Backed by RateLimitEvent rows
//      this helper writes on every successful preflight.
//
//   2. Monthly spend cap (calendar month): sum tokens from
//      AiAssetSuggestion for this tenant in the current calendar
//      month, convert to USD with the model's per-token price, refuse
//      if cumulative spend already exceeds tenant.monthlyAiSpendCapUsd
//      (or the env default).
//
// Design notes:
//
//   - Checked post-flight on prior calls. The CURRENT call may push
//     spend over the cap by its own cost; subsequent calls then refuse
//     until the calendar rolls. That's an acceptable v1 — true pre-
//     flight metering would require either pre-tokenizing the prompt
//     or a token-bucket reservation system, neither of which is worth
//     the complexity for a 5–25% over-cap tail.
//
//   - Pricing is hardcoded per model from Anthropic's published
//     pricing as of 2026-04-29. If pricing changes (it has historically
//     trended down), update PRICING below — no schema change needed.
//
//   - The action string is free-form; pick a short stable identifier
//     ("classifyCapex", "classifyImpairment", "classifyUsefulLife").
//     Per-action limits aren't enforced today, but rows are tagged so
//     we can analyze + tighten later without a migration.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";

// ─── Limits (env-overridable) ────────────────────────────────────────────

// Tenant-level: how many AI calls a single tenant can make in the
// trailing hour. Generous for a working CPA; 1 every 6 seconds on
// average. Override via AI_TENANT_HOURLY_LIMIT.
const TENANT_HOURLY_LIMIT = numFromEnv("AI_TENANT_HOURLY_LIMIT", 600);

// User-level: per-minute burst protection. A human clicking buttons
// can't realistically exceed 60/min; a runaway script can. Override
// via AI_USER_MINUTE_LIMIT.
const USER_MINUTE_LIMIT = numFromEnv("AI_USER_MINUTE_LIMIT", 60);

// Default monthly spend cap if the tenant row hasn't set its own.
// $50/mo is enough for a few hundred Opus extractions or thousands of
// Haiku match runs. Override via AI_TENANT_MONTHLY_CAP_USD.
const DEFAULT_MONTHLY_CAP_USD = numFromEnv("AI_TENANT_MONTHLY_CAP_USD", 50);

function numFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── Anthropic pricing ($/M tokens) ──────────────────────────────────────

// Source: anthropic.com/pricing as of cached date 2026-04-29.
// Only the models fa-amort uses are listed.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 5,   output: 25 },
  "claude-opus-4-6":   { input: 5,   output: 25 },
  "claude-sonnet-4-6": { input: 3,   output: 15 },
  "claude-haiku-4-5":  { input: 1,   output: 5  },
};

// ─── Errors ──────────────────────────────────────────────────────────────

export class RateLimitExceededError extends Error {
  constructor(public readonly scope: "tenant" | "user", public readonly limit: number, public readonly windowSeconds: number) {
    super(
      scope === "tenant"
        ? `Tenant rate limit: ${limit} AI calls per hour. Try again in a few minutes.`
        : `User rate limit: ${limit} AI calls per minute. Slow down.`
    );
    this.name = "RateLimitExceededError";
  }
}

export class MonthlySpendCapExceededError extends Error {
  constructor(public readonly spentUsd: Decimal, public readonly capUsd: Decimal) {
    super(
      `Monthly Anthropic spend cap exceeded: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} used this calendar month. ` +
        `Wait for the next month or ask an admin to raise tenant.monthlyAiSpendCapUsd.`
    );
    this.name = "MonthlySpendCapExceededError";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface EnforceAiBudgetArgs {
  tenantId: string;
  userId: string;
  action: string;
}

/**
 * Run BEFORE calling Anthropic. Throws RateLimitExceededError or
 * MonthlySpendCapExceededError when the call must be refused.
 * On success, writes a RateLimitEvent row so subsequent calls see
 * this one in the trailing window.
 */
export async function enforceAiBudget(args: EnforceAiBudgetArgs): Promise<void> {
  await checkMonthlySpendCap(args.tenantId);
  await checkRateLimits(args.tenantId, args.userId);
  // Log the call BEFORE making it. If the call itself fails, the row
  // stays — counts as a "burned slot" for rate limiting, which is the
  // intended behavior (a flapping API key shouldn't get unlimited retries).
  await prisma.rateLimitEvent.create({
    data: {
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.action,
    },
  });
}

async function checkRateLimits(tenantId: string, userId: string): Promise<void> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

  const [tenantHourly, userMinute] = await Promise.all([
    prisma.rateLimitEvent.count({
      where: { tenantId, createdAt: { gte: oneHourAgo } },
    }),
    prisma.rateLimitEvent.count({
      where: { tenantId, userId, createdAt: { gte: oneMinuteAgo } },
    }),
  ]);

  if (tenantHourly >= TENANT_HOURLY_LIMIT) {
    throw new RateLimitExceededError("tenant", TENANT_HOURLY_LIMIT, 3600);
  }
  if (userMinute >= USER_MINUTE_LIMIT) {
    throw new RateLimitExceededError("user", USER_MINUTE_LIMIT, 60);
  }
}

async function checkMonthlySpendCap(tenantId: string): Promise<void> {
  const { spentUsd, capUsd } = await computeMonthlySpend(tenantId);
  if (spentUsd.greaterThanOrEqualTo(capUsd)) {
    throw new MonthlySpendCapExceededError(spentUsd, capUsd);
  }
}

/**
 * Compute this tenant's Anthropic spend in the current calendar month
 * and resolve its cap. Returns both as Decimal so callers (cap check,
 * alert helper) can do their own comparisons without re-querying.
 */
async function computeMonthlySpend(tenantId: string): Promise<{
  spentUsd: Decimal;
  capUsd: Decimal;
}> {
  // Cap: tenant.monthlyAiSpendCapUsd or env default.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { monthlyAiSpendCapUsd: true },
  });
  const capUsd = tenant?.monthlyAiSpendCapUsd
    ? new Decimal(tenant.monthlyAiSpendCapUsd.toString())
    : new Decimal(DEFAULT_MONTHLY_CAP_USD);

  // Spend: sum (promptTokens, completionTokens) for this tenant in the
  // current calendar month, multiplied by per-model price. Done in
  // app code because the price table lives in TS, not the DB.
  const monthStart = startOfCurrentMonthUtc();
  const rows = await prisma.aiAssetSuggestion.findMany({
    where: { tenantId, createdAt: { gte: monthStart } },
    select: {
      modelName: true,
      promptTokens: true,
      completionTokens: true,
    },
  });

  let spentUsd = new Decimal(0);
  for (const r of rows) {
    const price = PRICING[r.modelName];
    if (!price) continue; // Unknown model — don't count, but don't block.
    const inputCost = new Decimal(r.promptTokens ?? 0)
      .mul(price.input)
      .div(1_000_000);
    const outputCost = new Decimal(r.completionTokens ?? 0)
      .mul(price.output)
      .div(1_000_000);
    spentUsd = spentUsd.plus(inputCost).plus(outputCost);
  }

  return { spentUsd, capUsd };
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function currentMonthKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// ─── Spend-threshold alerts ──────────────────────────────────────────────

/**
 * Fire at-most-once-per-month alerts when spend crosses the configured
 * thresholds (80% warning, 100% cap-reached).
 *
 * Call AFTER the AI Server Action persists its suggestion row (so this
 * tenant's spend total reflects the just-completed call). Errors here
 * are caught + logged — alerting must never fail the user's action.
 *
 * Delivery channels:
 *   1. INSERT into AiSpendAlert (auditable; the unique constraint on
 *      (tenantId, monthKey, threshold) dedupes — second crossing in
 *      the same month is a no-op).
 *   2. console.warn so platform logs surface it.
 *   3. If AI_ALERT_WEBHOOK_URL is set, POST JSON. Compatible with
 *      Slack incoming webhooks (just pass the Slack webhook URL).
 *      5-second timeout; failures swallowed (logged, not thrown).
 *
 * Thresholds are hardcoded [80, 100]. Add more by extending the
 * THRESHOLDS array — the dedup row keeps each crossing independent.
 */
const THRESHOLDS = [80, 100] as const;
const REPO_NAME = "fa-amort";

export async function emitSpendAlertIfThresholdCrossed(
  tenantId: string
): Promise<void> {
  try {
    const { spentUsd, capUsd } = await computeMonthlySpend(tenantId);
    if (capUsd.lessThanOrEqualTo(0)) return;
    const pctOfCap = spentUsd.div(capUsd).mul(100);
    const monthKey = currentMonthKey();

    for (const threshold of THRESHOLDS) {
      if (pctOfCap.lessThan(threshold)) continue;
      // Try to claim the alert slot via the unique constraint. If it
      // already exists for this month, the create rejects and we skip
      // — first call across the line wins, every subsequent call no-ops.
      try {
        await prisma.aiSpendAlert.create({
          data: {
            tenantId,
            monthKey,
            threshold,
            capUsd: capUsd.toFixed(2),
            spentUsd: spentUsd.toFixed(2),
          },
        });
      } catch (e) {
        // Unique violation = already alerted this month at this
        // threshold. That's the success case for dedup.
        if (isUniqueViolation(e)) continue;
        throw e;
      }
      // Slot claimed. Deliver.
      const message = formatAlertMessage({
        tenantId,
        monthKey,
        threshold,
        capUsd,
        spentUsd,
      });
      console.warn(`[ai-spend-alert] ${message}`);
      await postWebhookBestEffort(message, {
        tenantId,
        monthKey,
        threshold,
        capUsd: capUsd.toFixed(2),
        spentUsd: spentUsd.toFixed(2),
        source: REPO_NAME,
      });
    }
  } catch (e) {
    // Alerting failures must NEVER bubble up to the user's action.
    // Log and swallow.
    console.error("[ai-spend-alert] failed to evaluate thresholds", e);
  }
}

function formatAlertMessage(args: {
  tenantId: string;
  monthKey: string;
  threshold: number;
  capUsd: Decimal;
  spentUsd: Decimal;
}): string {
  const verb = args.threshold >= 100 ? "REACHED" : "approaching";
  return (
    `[${REPO_NAME}] Tenant ${args.tenantId} ${verb} ${args.threshold}% ` +
    `of the Anthropic spend cap for ${args.monthKey} — ` +
    `$${args.spentUsd.toFixed(2)} of $${args.capUsd.toFixed(2)}.`
  );
}

async function postWebhookBestEffort(
  text: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = process.env.AI_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    // Slack-compatible body: { text } is the minimum incoming-webhook
    // shape. We also pass structured data alongside so custom endpoints
    // can use it. Slack silently ignores extra keys.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(
        `[ai-spend-alert] webhook returned ${res.status}: ${await res
          .text()
          .catch(() => "<unreadable>")}`
      );
    }
  } catch (e) {
    console.error("[ai-spend-alert] webhook POST failed", e);
  }
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: string }).code;
  return code === "P2002"; // Prisma's unique-constraint violation code
}
