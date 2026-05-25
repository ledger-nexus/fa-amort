"use server";

// acceptCapexSuggestionAction + rejectCapexSuggestionAction.
//
// These Server Actions complete the AI loop on /ai-capex:
//
//   ACCEPT:
//     1. Validates the user-supplied final inputs (asset code, cost,
//        in-service date, entity, books).
//     2. POSTs to ledger-core's /api/internal/fixed-asset to create
//        the FixedAsset row + its per-book FixedAssetBookAttributes.
//     3. Stamps the AiAssetSuggestion row: assetId = newly-created
//        FixedAsset.id, outputJson.decision = "ACCEPTED" with the
//        timestamp + approver email (when v0.3 auth lands; "system"
//        for now).
//
//   REJECT:
//     - Just stamps outputJson.decision = "REJECTED" + rationale.
//     - No FixedAsset created.
//     - The audit row stays — proof the human stayed in the loop.
//
// Idempotency: re-accepting an already-ACCEPTED suggestion returns the
// existing assetId without creating a second row. ledger-core's
// fixed-asset endpoint also dedupes on (entityCode, code), so even a
// race produces one asset.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  createFixedAssetViaLedgerCore,
  LedgerCoreError,
  friendlyLedgerError,
  type CreateFixedAssetBookInput,
} from "@/lib/ledger-bridge";

export interface AcceptCapexInput {
  suggestionId: string;
  // What the human typed/confirmed on the form. The AI pre-fills
  // most of these; the user can override before submitting.
  entityCode: string;
  assetCode: string;
  description: string;
  category?: string;
  vendorPartyCode?: string;
  acquisitionDate: string;                 // ISO YYYY-MM-DD
  acquisitionCost: string | number;
  acquisitionCurrencyCode: string;
  assetAccountCode: string;
  // One row per book. UI typically defaults to US_GAAP + US_TAX with
  // book-specific useful lives.
  books: Array<{
    bookCode: string;
    usefulLifeMonths: number;
    salvageValuePercent: number;           // 0–100; multiplied by cost in the action
    inServiceDate: string;                 // ISO YYYY-MM-DD
    depreciationExpenseAccountCode: string;
    accumDepreciationAccountCode: string;
  }>;
}

export interface AcceptCapexState {
  ok: boolean;
  message?: string;
  assetId?: string;
  assetCode?: string;
  wasDuplicate?: boolean;
  wasAlreadyAccepted?: boolean;
}

export async function acceptCapexSuggestionAction(
  input: AcceptCapexInput
): Promise<AcceptCapexState> {
  try {
    // Validate inputs early so we don't waste a ledger-core round trip.
    if (!input.suggestionId) {
      return { ok: false, message: "suggestionId is required" };
    }
    if (
      !input.entityCode ||
      !input.assetCode ||
      !input.description ||
      !input.acquisitionDate ||
      input.acquisitionCost == null ||
      !input.acquisitionCurrencyCode ||
      !input.assetAccountCode ||
      input.books.length === 0
    ) {
      return {
        ok: false,
        message:
          "Fill in entity, asset code, description, acquisition date + cost + currency, asset account, and at least one book.",
      };
    }

    const suggestion = await prisma.aiAssetSuggestion.findUnique({
      where: { id: input.suggestionId },
      select: { id: true, kind: true, outputJson: true, assetId: true },
    });
    if (!suggestion) {
      return { ok: false, message: `Suggestion ${input.suggestionId} not found.` };
    }
    if (suggestion.kind !== "CAPEX_CLASSIFICATION") {
      return {
        ok: false,
        message: `Suggestion ${input.suggestionId} is ${suggestion.kind}, not a capex classification.`,
      };
    }

    // Idempotency: if this suggestion was already accepted and an asset
    // exists, short-circuit with the existing id.
    const existingDecision = (suggestion.outputJson as { decision?: string })
      ?.decision;
    if (existingDecision === "ACCEPTED" && suggestion.assetId) {
      return {
        ok: true,
        message: "This suggestion was already accepted.",
        assetId: suggestion.assetId,
        wasAlreadyAccepted: true,
      };
    }

    const cost = Number(input.acquisitionCost);
    if (!Number.isFinite(cost) || cost <= 0) {
      return { ok: false, message: "acquisitionCost must be a positive number." };
    }

    // Per-book salvage = cost × percent. The AI gave us a percentage
    // (more interpretable across reviews); the ledger schema wants
    // dollars. Compute here so the form stays human-friendly.
    const books: CreateFixedAssetBookInput[] = input.books.map((b) => ({
      bookCode: b.bookCode,
      usefulLifeMonths: b.usefulLifeMonths,
      method: "STRAIGHT_LINE", // v0.3 only — MACRS lands later
      inServiceDate: new Date(b.inServiceDate),
      salvageValue: (cost * b.salvageValuePercent) / 100,
      depreciationExpenseAccountCode: b.depreciationExpenseAccountCode,
      accumDepreciationAccountCode: b.accumDepreciationAccountCode,
    }));

    // Create the asset via ledger-core. ledger-core dedupes on
    // (entityCode, code) so retries are safe.
    const created = await createFixedAssetViaLedgerCore({
      entityCode: input.entityCode,
      code: input.assetCode,
      description: input.description,
      category: input.category,
      vendorPartyCode: input.vendorPartyCode || undefined,
      acquisitionDate: new Date(input.acquisitionDate),
      acquisitionCost: cost,
      acquisitionCurrencyCode: input.acquisitionCurrencyCode,
      assetAccountCode: input.assetAccountCode,
      books,
      sourceSystem: "fa-amort",
      sourceRecordType: "AiCapexSuggestion",
      sourceRecordId: suggestion.id,
    });

    // Stamp the suggestion row: link the asset, mark decision = ACCEPTED.
    const prevOutput = (suggestion.outputJson as Record<string, unknown>) ?? {};
    await prisma.aiAssetSuggestion.update({
      where: { id: suggestion.id },
      data: {
        assetId: created.id,
        outputJson: {
          ...prevOutput,
          decision: "ACCEPTED",
          decidedAt: new Date().toISOString(),
          // v0.4 will write the real reviewer email here. For now the
          // dev-mode user is anonymous from fa-amort's perspective.
          decidedBy: "system",
          createdAssetId: created.id,
          createdAssetCode: created.code,
        } as object,
      },
    });

    revalidatePath("/ai-capex");
    revalidatePath("/ai-audit");
    revalidatePath("/fixed-assets");

    return {
      ok: true,
      message: created.wasDuplicate
        ? `Asset ${created.code} already existed — linked the suggestion to it.`
        : `Created FixedAsset ${created.code}. View it on the fixed-assets list.`,
      assetId: created.id,
      assetCode: created.code,
      wasDuplicate: created.wasDuplicate,
    };
  } catch (e) {
    if (e instanceof LedgerCoreError) {
      return { ok: false, message: friendlyLedgerError(e) };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface RejectCapexInput {
  suggestionId: string;
  reason?: string;
}

export interface RejectCapexState {
  ok: boolean;
  message?: string;
}

export async function rejectCapexSuggestionAction(
  input: RejectCapexInput
): Promise<RejectCapexState> {
  try {
    if (!input.suggestionId) {
      return { ok: false, message: "suggestionId is required" };
    }
    const suggestion = await prisma.aiAssetSuggestion.findUnique({
      where: { id: input.suggestionId },
      select: { outputJson: true },
    });
    if (!suggestion) {
      return { ok: false, message: `Suggestion ${input.suggestionId} not found.` };
    }
    const prev = (suggestion.outputJson as Record<string, unknown>) ?? {};
    await prisma.aiAssetSuggestion.update({
      where: { id: input.suggestionId },
      data: {
        outputJson: {
          ...prev,
          decision: "REJECTED",
          decidedAt: new Date().toISOString(),
          decidedBy: "system",
          rejectReason: input.reason || null,
        } as object,
      },
    });
    revalidatePath("/ai-capex");
    revalidatePath("/ai-audit");
    return { ok: true, message: "Suggestion rejected. Audit row stays for the trail." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
