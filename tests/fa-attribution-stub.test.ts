// Contract tests for the DSR fa-attribution helper.
//
// As of 2026-06-05 (the attribution-schema migration + this PR), the
// helper is FULLY WIRED. It issues five COUNT(*) queries against the
// new attribution columns + returns real numbers. The file kept its
// historical name (`-stub`) for git-blame continuity, but the contract
// is now: real counts, not honest-zeros. See the matching integration
// test at `tests/fa-attribution-wired.test.ts` for non-zero proof.
//
// These tests lock the unit-level contract: function is exported,
// shape is stable, snapshotAt is well-formed, NotImplementedError
// class still exports for back-compat.

import { describe, it, expect, vi } from "vitest";
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

  it("throws when userId is empty string (13th-pass M2 guard)", async () => {
    const mockPrisma = {
      fixedAsset: { count: vi.fn().mockResolvedValue(0) },
      fixedAssetBookAttributes: { count: vi.fn().mockResolvedValue(0) },
      aiAssetSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(faAmortAttribution(mockPrisma, "")).rejects.toThrow(
      /userId is required/
    );
  });

  it("throws when userId is null (13th-pass M2 guard via TS bypass)", async () => {
    const mockPrisma = {
      fixedAsset: { count: vi.fn().mockResolvedValue(0) },
      fixedAssetBookAttributes: { count: vi.fn().mockResolvedValue(0) },
      aiAssetSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      faAmortAttribution(mockPrisma, null as any)
    ).rejects.toThrow(/userId is required/);
  });

  it("throws when userId is undefined (13th-pass M2 guard via TS bypass)", async () => {
    const mockPrisma = {
      fixedAsset: { count: vi.fn().mockResolvedValue(0) },
      fixedAssetBookAttributes: { count: vi.fn().mockResolvedValue(0) },
      aiAssetSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      faAmortAttribution(mockPrisma, undefined as any)
    ).rejects.toThrow(/userId is required/);
  });

  it("does NOT throw when called — returns wired shape", async () => {
    // Mock a prisma whose count() returns 0 — proves the function
    // resolves without explosion when no data matches.
    const mockPrisma = {
      fixedAsset: { count: vi.fn().mockResolvedValue(0) },
      fixedAssetBookAttributes: { count: vi.fn().mockResolvedValue(0) },
      aiAssetSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await faAmortAttribution(mockPrisma, "test-user-id");
    expect(result).toBeDefined();
  });

  it("returns the expected count when prisma stubs return non-zero values", async () => {
    const mockPrisma = {
      fixedAsset: {
        count: vi
          .fn()
          .mockResolvedValueOnce(7) // createdBy
          .mockResolvedValueOnce(2), // disposedBy
      },
      fixedAssetBookAttributes: {
        count: vi.fn().mockResolvedValue(11), // lastRunBy
      },
      aiAssetSuggestion: {
        count: vi
          .fn()
          .mockResolvedValueOnce(5) // acceptedBy
          .mockResolvedValueOnce(1), // rejectedBy
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await faAmortAttribution(mockPrisma, "test-user-id");
    expect(result.fixedAssetsRegistered).toBe(7);
    expect(result.assetDisposalsAuthorized).toBe(2);
    expect(result.depreciationRunsInitiated).toBe(11);
    expect(result.aiAssetSuggestionsAccepted).toBe(5);
    expect(result.aiAssetSuggestionsRejected).toBe(1);
  });

  it("passes userId to every count where clause", async () => {
    const calls: Array<{ where: { [k: string]: unknown } }> = [];
    const captureCount = vi.fn(
      (args: { where: { [k: string]: unknown } }) => {
        calls.push(args);
        return Promise.resolve(0);
      }
    );
    const mockPrisma = {
      fixedAsset: { count: captureCount },
      fixedAssetBookAttributes: { count: captureCount },
      aiAssetSuggestion: { count: captureCount },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await faAmortAttribution(mockPrisma, "subject-user-id");
    // 5 calls — one per attribution count
    expect(calls).toHaveLength(5);
    // Each where clause must contain the subject user id under SOME
    // attribution column key. Defense-in-depth: catches a future
    // refactor that accidentally drops the userId from a query.
    const allWhereValues = calls.flatMap((c) => Object.values(c.where));
    expect(allWhereValues.every((v) => v === "subject-user-id")).toBe(true);
  });

  it("returns a valid ISO 8601 snapshotAt timestamp", async () => {
    const mockPrisma = {
      fixedAsset: { count: vi.fn().mockResolvedValue(0) },
      fixedAssetBookAttributes: { count: vi.fn().mockResolvedValue(0) },
      aiAssetSuggestion: { count: vi.fn().mockResolvedValue(0) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await faAmortAttribution(mockPrisma, "test-user-id");
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Parseable as a Date.
    const t = new Date(result.snapshotAt).getTime();
    expect(Number.isFinite(t)).toBe(true);
  });

  it("FaAmortAttribution interface shape is stable (counts only, no contents)", () => {
    const shape: FaAmortAttribution = {
      fixedAssetsRegistered: 0,
      depreciationRunsInitiated: 0,
      aiAssetSuggestionsAccepted: 0,
      aiAssetSuggestionsRejected: 0,
      assetDisposalsAuthorized: 0,
      snapshotAt: "2026-06-05T00:00:00.000Z",
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
