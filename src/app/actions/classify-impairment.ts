"use server";

// classifyImpairmentAction — runs the AI impairment-indicator screener
// and persists every call to AiAssetSuggestion with kind=IMPAIRMENT_INDICATOR.
//
// Output is a screening signal. Unlike capex (which has an explicit
// Accept→createFixedAsset path) or useful-life (which has an explicit
// "apply new life" path), impairment doesn't have a single ledger
// write to make from the suggestion. The downstream action is OFF-
// SYSTEM: the CPA either runs a formal Step 2 recoverability test or
// dismisses. Decision values are LIMITED to:
//
//   PENDING   - just classified, no human review yet
//   FLAGGED   - CPA confirmed worth a deeper look (added to workpapers)
//   DISMISSED - CPA reviewed and decided no follow-up needed
//
// (No "ACCEPTED & posted" — impairment recognition happens via a
// separate JE the CPA cuts manually after the recoverability test.)

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  classifyImpairment,
  type ImpairmentResponse,
} from "@/lib/ai/impairment-classifier";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  enforceAiBudget,
  emitSpendAlertIfThresholdCrossed,
  RateLimitExceededError,
  MonthlySpendCapExceededError,
} from "@/lib/auth/ai-budget";
import { requireRepoAccess, RepoNotIncludedError } from "@/lib/auth/repo-access";

export interface ClassifyImpairmentInput {
  sourceText: string;
  /** Short label for the audit log (e.g. "Q3 industry report excerpt"). */
  sourceLabel?: string;
}

export interface ClassifyImpairmentState {
  ok: boolean;
  message?: string;
  suggestionId?: string;
  response?: ImpairmentResponse;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  latencyMs?: number;
}

export async function classifyImpairmentAction(
  input: ClassifyImpairmentInput
): Promise<ClassifyImpairmentState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): same gate as capex.
    // Anonymous Anthropic spend through this endpoint is closed.
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requireRepoAccess(tenant);

    if (!input.sourceText?.trim()) {
      return { ok: false, message: "Source text is required." };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        message:
          "ANTHROPIC_API_KEY is not set in fa-amort's env. Add it to .env before running screenings.",
      };
    }

    await enforceAiBudget({
      tenantId: tenant.id,
      userId: user.id,
      action: "classifyImpairment",
    });

    const result = await classifyImpairment(input.sourceText);

    const stored = await prisma.aiAssetSuggestion.create({
      data: {
        kind: "IMPAIRMENT_INDICATOR",
        tenantId: tenant.id,
        // No asset attachment — impairment screening operates on text,
        // not a specific FixedAsset row.
        inputText: input.sourceLabel
          ? `[${input.sourceLabel}]\n${input.sourceText}`
          : input.sourceText,
        outputJson: {
          response: result.response,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          decision: "PENDING",
        } as object,
        modelName: result.modelName,
        promptHash: result.promptHash,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
      },
      select: { id: true },
    });

    await emitSpendAlertIfThresholdCrossed(tenant.id);

    revalidatePath("/ai-impairment");
    revalidatePath("/ai-audit");

    return {
      ok: true,
      suggestionId: stored.id,
      response: result.response,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      latencyMs: result.latencyMs,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof RateLimitExceededError || e instanceof MonthlySpendCapExceededError)
      return { ok: false, message: e.message };
    if (e instanceof RepoNotIncludedError)
      return { ok: false, message: e.message };
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Screening failed",
    };
  }
}

// FLAGGED / DISMISSED decision actions — stamp the suggestion row
// with the human's call. Audit row stays; nothing else moves.

export interface DecideImpairmentInput {
  suggestionId: string;
  decision: "FLAGGED" | "DISMISSED";
  notes?: string;
}

export interface DecideImpairmentState {
  ok: boolean;
  message?: string;
}

export async function decideImpairmentAction(
  input: DecideImpairmentInput
): Promise<DecideImpairmentState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): the decision write is a
    // privileged stamp on a row that can carry sensitive screening
    // text. Tenant-scope the lookup so a foreign caller can't decide
    // (and thereby append decidedBy / notes to) another tenant's
    // suggestion. Pre-existing rows with tenantId null are unrecoverable
    // and refused.
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    if (!input.suggestionId) {
      return { ok: false, message: "suggestionId is required" };
    }
    if (input.decision !== "FLAGGED" && input.decision !== "DISMISSED") {
      return {
        ok: false,
        message: 'decision must be "FLAGGED" or "DISMISSED"',
      };
    }
    const suggestion = await prisma.aiAssetSuggestion.findFirst({
      where: { id: input.suggestionId, tenantId: tenant.id },
      select: { kind: true, outputJson: true },
    });
    if (!suggestion) {
      return { ok: false, message: `Suggestion ${input.suggestionId} not found.` };
    }
    if (suggestion.kind !== "IMPAIRMENT_INDICATOR") {
      return {
        ok: false,
        message: `Suggestion ${input.suggestionId} is ${suggestion.kind}, not an impairment indicator.`,
      };
    }
    const prev = (suggestion.outputJson as Record<string, unknown>) ?? {};
    await prisma.aiAssetSuggestion.update({
      where: { id: input.suggestionId },
      data: {
        outputJson: {
          ...prev,
          decision: input.decision,
          decidedAt: new Date().toISOString(),
          decidedBy: "system",
          notes: input.notes || null,
        } as object,
      },
    });
    revalidatePath("/ai-impairment");
    revalidatePath("/ai-audit");
    return {
      ok: true,
      message:
        input.decision === "FLAGGED"
          ? "Flagged for follow-up. Run the formal Step 2 recoverability test next."
          : "Dismissed. Audit row stays as proof of review.",
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
