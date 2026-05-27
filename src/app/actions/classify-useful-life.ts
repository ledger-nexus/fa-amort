"use server";

// classifyUsefulLifeAction — runs the AI useful-life reassessment and
// persists the call to AiAssetSuggestion.
//
// Same audit discipline as the capex classifier: every call writes a row,
// regardless of whether the human accepts the recommendation.
//
// v0.5 surface: returns the recommendation; a follow-up action (lands
// in v0.6) will write the new usefulLifeMonths back to
// FixedAssetBookAttributes via a new ledger-core endpoint. For now the
// CPA reads the recommendation and edits the asset manually.
//
// inputText on the audit row is the human-readable facts blob so the
// audit log shows what was asked, not a raw object dump.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  classifyUsefulLife,
  type AssetFactSheet,
  type UsefulLifeRecommendation,
} from "@/lib/ai/useful-life-classifier";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import {
  enforceAiBudget,
  RateLimitExceededError,
  MonthlySpendCapExceededError,
} from "@/lib/auth/ai-budget";

export interface ClassifyUsefulLifeInput {
  /** When tied to an existing asset, the AiAssetSuggestion gets assetId stamped. */
  assetId?: string;
  facts: AssetFactSheet;
}

export interface ClassifyUsefulLifeState {
  ok: boolean;
  message?: string;
  suggestionId?: string;
  recommendation?: UsefulLifeRecommendation;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  latencyMs?: number;
}

export async function classifyUsefulLifeAction(
  input: ClassifyUsefulLifeInput
): Promise<ClassifyUsefulLifeState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): same gate as the other
    // classifiers. If assetId is provided, also verify it belongs to
    // this tenant — otherwise an attacker could attach the audit row
    // to a foreign asset (subtle but in spec for cross-tenant write).
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const f = input.facts;
    if (!f?.description?.trim()) {
      return { ok: false, message: "Asset description is required." };
    }
    if (!f.category || !f.bookCode) {
      return { ok: false, message: "Category and book code are required." };
    }
    if (!Number.isInteger(f.originalUsefulLifeMonths) || f.originalUsefulLifeMonths < 1) {
      return { ok: false, message: "Original useful life must be a positive integer (months)." };
    }
    if (!Number.isInteger(f.monthsInService) || f.monthsInService < 0) {
      return { ok: false, message: "Months in service must be a non-negative integer." };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        message:
          "ANTHROPIC_API_KEY is not set in fa-amort's env. Add it to .env before running classifications.",
      };
    }

    // Verify assetId belongs to this tenant if supplied.
    if (input.assetId) {
      const asset = await prisma.fixedAsset.findFirst({
        where: { id: input.assetId, entity: { tenantId: tenant.id } },
        select: { id: true },
      });
      if (!asset) {
        return {
          ok: false,
          message: `Asset ${input.assetId} not found in this tenant.`,
        };
      }
    }

    await enforceAiBudget({
      tenantId: tenant.id,
      userId: user.id,
      action: "classifyUsefulLife",
    });

    const result = await classifyUsefulLife(f);

    // Build a human-readable inputText so the audit log shows what we asked.
    const inputText = [
      `Reassess useful life — ${f.category}`,
      `Description: ${f.description}`,
      `Original life: ${f.originalUsefulLifeMonths} months`,
      `In service: ${f.monthsInService} months`,
      `Book: ${f.bookCode}`,
      f.conditionNotes ? `Notes: ${f.conditionNotes}` : null,
      f.externalSignals ? `Signals: ${f.externalSignals}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const stored = await prisma.aiAssetSuggestion.create({
      data: {
        kind: "USEFUL_LIFE",
        tenantId: tenant.id,
        assetId: input.assetId ?? null,
        inputText,
        outputJson: {
          recommendation: result.recommendation,
          facts: f,
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

    revalidatePath("/ai-useful-life");
    revalidatePath("/ai-audit");

    return {
      ok: true,
      suggestionId: stored.id,
      recommendation: result.recommendation,
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
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Classification failed",
    };
  }
}
