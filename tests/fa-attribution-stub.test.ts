// Contract tests for the DSR fa-attribution helper.
//
// fa-amort has no user-attribution columns on its owned models
// (FixedAsset, FixedAssetBookAttributes, AiAssetSuggestion). The
// helper returns honest zeros + delegates real attribution to
// ledger-core's audit_log. See the SCHEMA GAP note in
// `src/lib/privacy/fa-attribution.ts` for the rationale.
//
// These tests lock the contract: the function does NOT throw, returns
// a stable shape, all counts are zero today. When the schema gap
// closes, the integration tests added at that time will assert the
// non-zero counts.

import { describe, it, expect } from "vitest";
import {
  faAmortAttribution,
  NotImplementedError,
  type FaAmortAttribution,
} from "../src/lib/privacy/fa-attribution";

describe("DSR — fa-amort attribution contract (Privacy TSC)", () => {
  it("exports the faAmortAttribution function", () => {
    expect(typeof faAmortAttribution).toBe("function");
  });

  it("retains the NotImplementedError class export (back-compat)", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("does NOT throw when called — returns honest-zero shape", async () => {
    // The function is now wired (no throw). Real attribution is
    // delegated to ledger-core's audit_log (see file's SCHEMA GAP note).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    const result = await faAmortAttribution(fakePrisma, "test-user-id");
    expect(result).toBeDefined();
  });

  it("returns all-zero counts today (schema gap — no attribution columns)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    const result = await faAmortAttribution(fakePrisma, "test-user-id");
    expect(result.fixedAssetsRegistered).toBe(0);
    expect(result.depreciationRunsInitiated).toBe(0);
    expect(result.aiAssetSuggestionsAccepted).toBe(0);
    expect(result.aiAssetSuggestionsRejected).toBe(0);
    expect(result.assetDisposalsAuthorized).toBe(0);
  });

  it("returns a valid ISO 8601 snapshotAt timestamp", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    const result = await faAmortAttribution(fakePrisma, "test-user-id");
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Parseable as a Date.
    const t = new Date(result.snapshotAt).getTime();
    expect(Number.isFinite(t)).toBe(true);
  });

  it("does not actually touch prisma (no DB calls today)", async () => {
    // Defense-in-depth: in the honest-zero state, the function MUST
    // NOT crash on a fake prisma. This proves the implementation
    // isn't accidentally awaiting a real query.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const explodingPrisma = new Proxy({} as any, {
      get() {
        throw new Error("prisma should not be touched in honest-zero mode");
      },
    });
    await expect(
      faAmortAttribution(explodingPrisma, "test-user-id")
    ).resolves.toBeDefined();
  });

  it("FaAmortAttribution interface shape is stable (counts only, no contents)", () => {
    const shape: FaAmortAttribution = {
      fixedAssetsRegistered: 0,
      depreciationRunsInitiated: 0,
      aiAssetSuggestionsAccepted: 0,
      aiAssetSuggestionsRejected: 0,
      assetDisposalsAuthorized: 0,
      snapshotAt: "2026-06-03T00:00:00.000Z",
    };
    expect(shape.fixedAssetsRegistered).toBe(0);

    // Sanity: the keys we DO have don't contain content-shaped names.
    const keys = Object.keys(shape);
    const forbidden = ["contents", "details", "rawdata", "description"];
    for (const k of keys) {
      for (const f of forbidden) {
        expect(k.toLowerCase()).not.toContain(f.toLowerCase());
      }
    }
  });
});
