"use server";

// classifyCapexAction — Server Action that drives the AI capex
// classifier and persists every call to AiAssetSuggestion.
//
// Same shape as recon's proposeMatchesAction and revenue-rec's
// extractContractAction: the AI proposes; this action does NOT post
// any JE, does NOT create any FixedAsset, does NOT change ledger state.
// A separate human-driven action (acceptCapexClassificationAction in
// v0.3) will take an accepted suggestion and turn it into a FixedAsset
// row via createFixedAsset.
//
// Audit discipline (from CLAUDE.md non-negotiable #3, mirrored in the
// other AI engines):
//   - EVERY call writes a row to AiAssetSuggestion — accepted, rejected,
//     and ignored alike.
//   - The full input text is persisted verbatim.
//   - The model's structured output is persisted in outputJson.
//   - Token usage + latency are persisted so the audit panel can show
//     real cost-per-classification.
//
// Failure modes:
//   - Anthropic SDK throws (rate limit, auth error, transient network):
//     surface as ok:false with the error message. We DO NOT swallow
//     these; an empty audit row is worse than a visible failure.
//   - Empty input text: rejected at the helper level with a clear
//     error, NO suggestion row written (nothing to audit).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  classifyCapex,
  type Classification,
} from "@/lib/ai/capex-classifier";
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

export interface ClassifyCapexInput {
  invoiceText: string;
}

export interface ClassifyCapexState {
  ok: boolean;
  message?: string;
  /** AiAssetSuggestion.id — UI uses this for the "accept/reject" follow-up. */
  suggestionId?: string;
  classification?: Classification;
  /** Token usage for cost telemetry, surfaced inline in the UI. */
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  latencyMs?: number;
}

export async function classifyCapexAction(
  input: ClassifyCapexInput
): Promise<ClassifyCapexState> {
  try {
    // SECURITY (pen-test pass 4 follow-up): require auth + tenant.
    // This action calls Anthropic (per-tenant cost) and writes an
    // audit row. Anonymous classifier spend was on the deferred list
    // from pen-test pass 4 — this closes it.
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    if (!input.invoiceText?.trim()) {
      return { ok: false, message: "Enter a purchase description first." };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        message:
          "ANTHROPIC_API_KEY is not set in fa-amort's env. Add it to .env before running classifications.",
      };
    }

    // Rate limit + monthly spend cap. Throws if either is hit;
    // logs a RateLimitEvent row on success so subsequent calls see
    // this one in the trailing window.
    await enforceAiBudget({
      tenantId: tenant.id,
      userId: user.id,
      action: "classifyCapex",
    });

    const result = await classifyCapex(input.invoiceText);

    const stored = await prisma.aiAssetSuggestion.create({
      data: {
        // assetId is null — CAPEX_CLASSIFICATION runs BEFORE the FixedAsset
        // exists. If the human accepts the suggestion and a FixedAsset is
        // created, a separate Server Action backfills the assetId.
        kind: "CAPEX_CLASSIFICATION",
        tenantId: tenant.id,
        inputText: input.invoiceText,
        outputJson: {
          classification: result.classification,
          // Stash the cache-token counts here so the audit panel can render
          // them without a schema migration. Cleaner to promote to columns
          // in v0.3 once the volume justifies it.
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

    revalidatePath("/ai-capex");
    revalidatePath("/ai-audit");

    return {
      ok: true,
      suggestionId: stored.id,
      classification: result.classification,
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

// Note: a Next.js "use server" file can only export async functions.
// The model-name constant lives on the classifier module — import it
// directly from @/lib/ai/capex-classifier in pages.
