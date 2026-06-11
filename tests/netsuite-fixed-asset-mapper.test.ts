// Pure-function tests for the NetSuite fixed-asset mapper.
// No DB required.

import { describe, it, expect } from "vitest";
import {
  mapNsFixedAsset,
  mapNsFixedAssets,
  nsFixedAssetCode,
  type NsFixedAsset,
} from "../src/lib/mappers/netsuite/fixed-asset";

const baseAsset: NsFixedAsset = {
  id: 42,
  asset_number: "FA-42",
  name: "Test Asset",
  description: "Production server",
  asset_type: "Hardware",
  acquisition_date: "2024-01-15",
  placed_in_service_date: "2024-02-01",
  original_cost: 12000,
  residual_value: 1000,
  useful_life_months: 36,
  depreciation_method: "Straight Line",
  accumulated_depreciation: 5500,
  current_book_value: 6500,
  location_id: 7,
  custodian_id: 23,
  subsidiary_id: 9,
  asset_account_id: 101,
  depreciation_account_id: 201,
  accumulated_depr_account_id: 202,
  status: "active",
};

const opts = { bookCode: "US_GAAP" };

describe("nsFixedAssetCode", () => {
  it("prefixes with NSFA-", () => {
    expect(nsFixedAssetCode(42)).toBe("NSFA-42");
    expect(nsFixedAssetCode("abc-9")).toBe("NSFA-abc-9");
  });
});

describe("mapNsFixedAsset — base translation", () => {
  it("translates the headline fields", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.code).toBe("NSFA-42");
    expect(m.description).toBe("Production server");
    expect(m.category).toBe("Hardware");
    expect(m.acquisitionDate).toBe("2024-01-15");
    expect(m.acquisitionCost).toBe(12000);
    expect(m.acquisitionCurrencyCode).toBe("USD");
    expect(m.status).toBe("IN_SERVICE");
  });

  it("populates the lineage triple", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.sourceSystem).toBe("NETSUITE");
    expect(m.sourceRecordType).toBe("FixedAsset");
    expect(m.sourceRecordId).toBe("42");
    expect(m.sourcePayload).toEqual(baseAsset);
  });

  it("falls back to name when description is absent", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, description: undefined },
      opts
    );
    expect(m.description).toBe("Test Asset");
  });

  it("falls back to 'Asset {id}' when both description and name are absent", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, description: undefined, name: undefined },
      opts
    );
    expect(m.description).toBe("Asset 42");
  });

  it("preserves NetSuite-specific fields in extensions Json", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.extensions.custodianId).toBe(23);
    expect(m.extensions.locationId).toBe(7);
    expect(m.extensions.currentBookValueAtImport).toBe(6500);
  });

  it("omits extension fields that are null/undefined", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, custodian_id: undefined, location_id: undefined },
      opts
    );
    expect(m.extensions.custodianId).toBeUndefined();
    expect(m.extensions.locationId).toBeUndefined();
  });
});

describe("mapNsFixedAsset — bookAttributes", () => {
  it("builds a single bookAttributes entry with the caller's bookCode", () => {
    const m = mapNsFixedAsset(baseAsset, { bookCode: "IFRS" });
    expect(m.bookAttributes).toHaveLength(1);
    expect(m.bookAttributes[0]!.bookCode).toBe("IFRS");
  });

  it("translates depreciation params (life, salvage, accumulated)", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    const ba = m.bookAttributes[0]!;
    expect(ba.usefulLifeMonths).toBe(36);
    expect(ba.salvageValue).toBe(1000);
    expect(ba.accumulatedDepreciation).toBe(5500);
  });

  it("uses placed_in_service_date for inServiceDate when present", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.bookAttributes[0]!.inServiceDate).toBe("2024-02-01");
  });

  it("falls back to acquisition_date for inServiceDate", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, placed_in_service_date: undefined },
      opts
    );
    expect(m.bookAttributes[0]!.inServiceDate).toBe("2024-01-15");
  });
});

describe("mapNsFixedAsset — depreciation method mapping", () => {
  it("maps 'Straight Line' (Fleet shape) → STRAIGHT_LINE", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Straight Line" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("STRAIGHT_LINE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toBeUndefined();
  });

  it("maps snake_case 'straight_line' → STRAIGHT_LINE", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "straight_line" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("STRAIGHT_LINE");
  });

  it("maps 'Double Declining Balance' → DOUBLE_DECLINING", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Double Declining Balance" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("DOUBLE_DECLINING");
  });

  it("maps 'MACRS 5-year' → MACRS_5_HY", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "MACRS 5-year" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("MACRS_5_HY");
  });

  it("maps 'Units of Production' → UNITS_OF_PRODUCTION", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Units of Production" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe(
      "UNITS_OF_PRODUCTION"
    );
  });

  it("maps 'None' (asset not yet depreciating) → NONE", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "None" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("NONE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toBeUndefined();
  });
});

describe("mapNsFixedAsset — unmapped methods surface notes", () => {
  it("maps '150% Declining Balance' → NONE with a note", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "150% Declining Balance" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("NONE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toMatch(/150% DB/);
  });

  it("maps 'Sum of Years Digits' → NONE with a note", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Sum of Years Digits" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("NONE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toMatch(/SYD/);
  });

  it("maps 'Amortization' → NONE with a note (intangible carve-out)", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Amortization" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("NONE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toMatch(/intangible/);
  });

  it("maps an unrecognized method → NONE with a generic note", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, depreciation_method: "Quantum Drift Method" },
      opts
    );
    expect(m.bookAttributes[0]!.depreciationMethod).toBe("NONE");
    expect(m.bookAttributes[0]!.unmappedMethodNote).toMatch(
      /Quantum Drift Method/
    );
  });
});

describe("mapNsFixedAsset — status mapping", () => {
  it("maps 'active' → IN_SERVICE", () => {
    const m = mapNsFixedAsset({ ...baseAsset, status: "active" }, opts);
    expect(m.status).toBe("IN_SERVICE");
  });

  it("maps 'fully_depreciated' → IN_SERVICE (NBV=salvage but still in service)", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, status: "fully_depreciated" },
      opts
    );
    expect(m.status).toBe("IN_SERVICE");
  });

  it("maps 'disposed' → DISPOSED", () => {
    const m = mapNsFixedAsset({ ...baseAsset, status: "disposed" }, opts);
    expect(m.status).toBe("DISPOSED");
  });

  it("maps 'retired' → DISPOSED (treats retirement as disposal)", () => {
    const m = mapNsFixedAsset({ ...baseAsset, status: "retired" }, opts);
    expect(m.status).toBe("DISPOSED");
  });

  it("maps 'idle' → IDLE", () => {
    const m = mapNsFixedAsset({ ...baseAsset, status: "idle" }, opts);
    expect(m.status).toBe("IDLE");
  });

  it("falls back to IN_SERVICE for unrecognized statuses", () => {
    const m = mapNsFixedAsset(
      { ...baseAsset, status: "schrodinger" },
      opts
    );
    expect(m.status).toBe("IN_SERVICE");
  });
});

describe("mapNsFixedAsset — account code resolution", () => {
  it("uses resolveAccountCode callback when provided", () => {
    const resolver = (id: string | number | undefined) =>
      id != null ? `ACCT-${id}-RESOLVED` : null;
    const m = mapNsFixedAsset(baseAsset, {
      bookCode: "US_GAAP",
      resolveAccountCode: resolver,
    });
    expect(m.assetAccountCode).toBe("ACCT-101-RESOLVED");
    expect(m.bookAttributes[0]!.depreciationExpenseAccountCode).toBe(
      "ACCT-201-RESOLVED"
    );
    expect(m.bookAttributes[0]!.accumDepreciationAccountCode).toBe(
      "ACCT-202-RESOLVED"
    );
  });

  it("falls back to NSACCT-{id} when resolver returns null", () => {
    const resolver = () => null;
    const m = mapNsFixedAsset(baseAsset, {
      bookCode: "US_GAAP",
      resolveAccountCode: resolver,
    });
    expect(m.assetAccountCode).toBe("NSACCT-101");
  });

  it("uses NSACCT-{id} when no resolver is provided", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.assetAccountCode).toBe("NSACCT-101");
    expect(m.bookAttributes[0]!.depreciationExpenseAccountCode).toBe(
      "NSACCT-201"
    );
  });

  it("returns UNRESOLVED when account IDs are absent and no resolver helps", () => {
    const m = mapNsFixedAsset(
      {
        ...baseAsset,
        asset_account_id: undefined,
        depreciation_account_id: undefined,
        accumulated_depr_account_id: undefined,
      },
      opts
    );
    expect(m.assetAccountCode).toBe("UNRESOLVED");
    expect(m.bookAttributes[0]!.depreciationExpenseAccountCode).toBe(
      "UNRESOLVED"
    );
  });
});

describe("mapNsFixedAsset — disposal", () => {
  it("translates disposal fields when present", () => {
    const m = mapNsFixedAsset(
      {
        ...baseAsset,
        status: "disposed",
        disposal_date: "2026-03-15",
        disposal_amount: 2500,
        gain_loss: 1500,
      },
      opts
    );
    expect(m.disposalDate).toBe("2026-03-15");
    expect(m.disposalProceeds).toBe(2500);
    expect(m.status).toBe("DISPOSED");
    expect(m.extensions.gainLoss).toBe(1500);
  });

  it("returns null disposal fields for in-service assets", () => {
    const m = mapNsFixedAsset(baseAsset, opts);
    expect(m.disposalDate).toBeNull();
    expect(m.disposalProceeds).toBeNull();
  });
});

describe("mapNsFixedAssets (batch helper)", () => {
  it("reports unmapped method counts", () => {
    const assets: NsFixedAsset[] = [
      { ...baseAsset, id: 1, depreciation_method: "Straight Line" },
      { ...baseAsset, id: 2, depreciation_method: "150% Declining Balance" },
      { ...baseAsset, id: 3, depreciation_method: "150% Declining Balance" },
      { ...baseAsset, id: 4, depreciation_method: "Sum of Years Digits" },
    ];
    const r = mapNsFixedAssets(assets, opts);
    expect(r.mapped).toHaveLength(4);
    expect(r.unmappedMethodCounts).toEqual({
      "150% Declining Balance": 2,
      "Sum of Years Digits": 1,
    });
  });

  it("reports unrecognized status counts", () => {
    const assets: NsFixedAsset[] = [
      { ...baseAsset, id: 1, status: "active" },
      { ...baseAsset, id: 2, status: "schrodinger" },
      { ...baseAsset, id: 3, status: "schrodinger" },
    ];
    const r = mapNsFixedAssets(assets, opts);
    expect(r.unrecognizedStatuses).toEqual({ schrodinger: 2 });
  });

  it("handles an empty array cleanly", () => {
    const r = mapNsFixedAssets([], opts);
    expect(r.mapped).toEqual([]);
    expect(r.unmappedMethodCounts).toEqual({});
    expect(r.unrecognizedStatuses).toEqual({});
  });
});
