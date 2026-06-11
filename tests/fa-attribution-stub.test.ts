// Test for the DSR attribution stub.
// See recon/tests/recon-attribution-stub.test.ts for rationale.

import { describe, it, expect } from "vitest";
import {
  faAmortAttribution,
  NotImplementedError,
  type FaAmortAttribution,
} from "../src/lib/privacy/fa-attribution";

describe("DSR — fa-amort attribution stub (Privacy TSC contract)", () => {
  it("exports the faAmortAttribution function", () => {
    expect(typeof faAmortAttribution).toBe("function");
  });

  it("exports the NotImplementedError class", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("throws NotImplementedError when called (locks the contract)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    await expect(faAmortAttribution(fakePrisma, "test-user-id")).rejects.toThrow(
      NotImplementedError
    );
  });

  it("error message points at the DSR doc's Open items section", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    try {
      await faAmortAttribution(fakePrisma, "test-user-id");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/data-subject-requests/);
      expect((e as Error).message).toMatch(/Open items/);
    }
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
  });
});
