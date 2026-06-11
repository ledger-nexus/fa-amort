// NetSuite fixed-asset mapper for fa-amort.
//
// Translates NetSuite `fixed_assets` rows into the JSON shape
// fa-amort's `FixedAsset` + `FixedAssetBookAttributes` would accept.
//
// Surfaced by the fa-amort validation pass
// (ledger-core/docs/reference/netsuite-fa-amort-validation.md PR #40)
// which showed 87/90 fully translatable. This module is the
// production-code closure of that gap report.
//
// Pattern mirrors ledger-core/src/lib/mappers/netsuite/bootstrap.ts:
//   - Pure mapper functions (no I/O)
//   - Snake_case NetSuite source-side shape
//   - Code conventions (NSFA-{id}) for code collision avoidance
//   - Lineage triple (sourceSystem, sourceRecordType, sourceRecordId)
//     populated on every mapped row
//
// What this module deliberately does NOT do:
//   - Database I/O. Idempotent import orchestrator + integration tests
//     belong in a follow-up PR (see netsuite-fixed-asset-import.ts when
//     added).
//   - depreciation_schedules row import. Historical schedules carry
//     over via accumulatedDepreciation + lastDepreciatedThrough on the
//     bookAttributes; full-schedule replay would require posting JEs
//     through the ledger-bridge and is out of scope for the mapper layer.
//   - Multi-book per-asset attributes. fa-amort's FixedAssetBookAttributes
//     is per (asset, book). NetSuite Fleet has 1 book in the per-asset
//     view; this mapper creates one bookAttributes entry tied to the
//     bookCode the caller specifies (typically US_GAAP).

// ─── NetSuite source-side shape ─────────────────────────────────────

/**
 * NetSuite `fixed_assets` row as observed in the Fleet sample data.
 * Field names match the NetSuite SuiteAnalytics export (snake_case).
 */
export interface NsFixedAsset {
  id: string | number;
  asset_number: string;
  name?: string;
  description?: string;
  asset_type?: string; // free-text category
  acquisition_date: string;
  placed_in_service_date?: string;
  original_cost: number;
  residual_value?: number;
  useful_life_months: number;
  depreciation_method: string;
  accumulated_depreciation?: number;
  current_book_value?: number; // denormalized — fa-amort computes on read
  location_id?: string | number;
  custodian_id?: string | number;
  subsidiary_id?: string | number;
  asset_account_id?: string | number;
  depreciation_account_id?: string | number;
  accumulated_depr_account_id?: string | number;
  disposal_date?: string;
  disposal_amount?: number;
  gain_loss?: number;
  status: string;
}

// ─── Mapped target shape ────────────────────────────────────────────

/**
 * fa-amort FixedAsset + bookAttributes target. Caller resolves
 * `entityCode` from the NetSuite subsidiary (typically via
 * ledger-core's NSSUB-{id} convention).
 */
export interface MappedFixedAsset {
  code: string;
  description: string;
  category: string | null;
  entityCode: string | null;
  vendorPartyCode: string | null;
  acquisitionDate: string;
  acquisitionCost: number;
  acquisitionCurrencyCode: string;
  status: "IN_SERVICE" | "IDLE" | "DISPOSED";
  disposalDate: string | null;
  disposalProceeds: number | null;
  assetAccountCode: string;
  bookAttributes: MappedFixedAssetBookAttributes[];
  // NetSuite-specific fields preserved in extensions Json (custodian,
  // location, denormalized current_book_value). The substrate doesn't
  // model these on the FixedAsset row directly.
  extensions: {
    custodianId?: string | number;
    locationId?: string | number;
    currentBookValueAtImport?: number;
    gainLoss?: number;
  };
  sourceSystem: "NETSUITE";
  sourceRecordType: "FixedAsset";
  sourceRecordId: string;
  sourcePayload: NsFixedAsset;
  mappingVersion: string;
}

export interface MappedFixedAssetBookAttributes {
  bookCode: string;
  usefulLifeMonths: number;
  depreciationMethod:
    | "STRAIGHT_LINE"
    | "DOUBLE_DECLINING"
    | "MACRS_3_HY"
    | "MACRS_5_HY"
    | "MACRS_7_HY"
    | "MACRS_15_HY"
    | "UNITS_OF_PRODUCTION"
    | "NONE";
  inServiceDate: string;
  salvageValue: number;
  accumulatedDepreciation: number;
  depreciationExpenseAccountCode: string;
  accumDepreciationAccountCode: string;
  // unmapped methods captured here for visibility; caller can treat as
  // an import-time validation error.
  unmappedMethodNote?: string;
}

// ─── Code convention ────────────────────────────────────────────────

export function nsFixedAssetCode(internalid: string | number): string {
  return `NSFA-${internalid}`;
}

// ─── Method + status mappings ───────────────────────────────────────

/**
 * NetSuite depreciation method strings → fa-amort DepreciationMethod
 * enum. The Fleet sample uses human-readable strings ("Straight Line",
 * not "straight_line"); we accept both for forward-compat with
 * NetSuite REST API variants.
 *
 * Three methods (150% DB, SYD, Amortization) lack a direct fa-amort
 * equivalent. These map to NONE with the unmappedMethodNote populated
 * so the import can surface a meaningful warning.
 */
const METHOD_MAP: Record<string, MappedFixedAssetBookAttributes["depreciationMethod"]> = {
  // Snake_case + human-readable variants both covered
  STRAIGHT_LINE: "STRAIGHT_LINE",
  straight_line: "STRAIGHT_LINE",
  "Straight Line": "STRAIGHT_LINE",
  DOUBLE_DECLINING: "DOUBLE_DECLINING",
  double_declining: "DOUBLE_DECLINING",
  double_declining_balance: "DOUBLE_DECLINING",
  "Double Declining": "DOUBLE_DECLINING",
  "Double Declining Balance": "DOUBLE_DECLINING",
  MACRS_3_HY: "MACRS_3_HY",
  "MACRS 3-year": "MACRS_3_HY",
  macrs_3: "MACRS_3_HY",
  MACRS_5_HY: "MACRS_5_HY",
  "MACRS 5-year": "MACRS_5_HY",
  macrs_5: "MACRS_5_HY",
  MACRS_7_HY: "MACRS_7_HY",
  "MACRS 7-year": "MACRS_7_HY",
  macrs_7: "MACRS_7_HY",
  MACRS_15_HY: "MACRS_15_HY",
  "MACRS 15-year": "MACRS_15_HY",
  macrs_15: "MACRS_15_HY",
  UNITS_OF_PRODUCTION: "UNITS_OF_PRODUCTION",
  "Units of Production": "UNITS_OF_PRODUCTION",
  units_of_production: "UNITS_OF_PRODUCTION",
  NONE: "NONE",
  None: "NONE",
  none: "NONE",
  null: "NONE",
};

const UNMAPPED_METHOD_NOTES: Record<string, string> = {
  "150% Declining Balance":
    "fa-amort has no 150% DB enum; mapped to NONE — import-time warning",
  "Sum of Years Digits":
    "fa-amort has no SYD enum; mapped to NONE — import-time warning",
  Amortization:
    "Amortization is for intangible assets; fa-amort covers tangible only — mapped to NONE",
};

const STATUS_MAP: Record<string, MappedFixedAsset["status"]> = {
  active: "IN_SERVICE",
  in_service: "IN_SERVICE",
  idle: "IDLE",
  disposed: "DISPOSED",
  retired: "DISPOSED",
  fully_depreciated: "IN_SERVICE", // NBV = salvage but still in service
};

// ─── Mapper function ────────────────────────────────────────────────

export interface MapNsFixedAssetOptions {
  /**
   * Book code for the FixedAssetBookAttributes row. Typically
   * "US_GAAP" — caller can override for IFRS / TAX / etc.
   */
  bookCode: string;
  /**
   * Entity code (ledger-core LegalEntity.code) the asset belongs to.
   * Typically resolved via ledger-core's NSSUB-{subsidiary_id}
   * convention. Pass null if entity bootstrap hasn't run yet.
   */
  entityCode?: string | null;
  /**
   * Currency code for the acquisition. Defaults to USD (NetSuite
   * Fleet doesn't expose per-asset currency).
   */
  acquisitionCurrencyCode?: string;
  /**
   * Vendor party code if resolvable. The fixed_assets table doesn't
   * directly carry a vendor FK; callers may resolve via custodian_id
   * or leave null.
   */
  vendorPartyCode?: string | null;
  /**
   * Account-code resolver. NetSuite stores numeric FKs to the accounts
   * table; the mapper needs a way to translate them to ledger-core's
   * string account codes. Caller provides the mapping (typically via
   * the same NetSuite → ledger-core account import that ran first).
   *
   * Return null if the ID can't be resolved; the mapper falls back
   * to `NSACCT-{id}` as a placeholder.
   */
  resolveAccountCode?: (
    nsAccountId: string | number | undefined
  ) => string | null;
  mappingVersion?: string;
}

export function mapNsFixedAsset(
  ns: NsFixedAsset,
  opts: MapNsFixedAssetOptions
): MappedFixedAsset {
  const mappingVersion = opts.mappingVersion ?? "ns-v1";
  const resolveAcct =
    opts.resolveAccountCode ??
    ((id) => (id != null ? `NSACCT-${id}` : null));

  // Resolve method
  const rawMethod = String(ns.depreciation_method ?? "");
  const mappedMethod = METHOD_MAP[rawMethod] ?? "NONE";
  const unmappedNote =
    METHOD_MAP[rawMethod] !== undefined
      ? undefined
      : (UNMAPPED_METHOD_NOTES[rawMethod] ??
        `Unrecognized depreciation_method '${rawMethod}'; mapped to NONE`);

  // Resolve status
  const mappedStatus = STATUS_MAP[ns.status] ?? "IN_SERVICE";

  // Account codes
  const assetAcct =
    resolveAcct(ns.asset_account_id) ??
    (ns.asset_account_id != null
      ? `NSACCT-${ns.asset_account_id}`
      : "UNRESOLVED");
  const depAcct =
    resolveAcct(ns.depreciation_account_id) ??
    (ns.depreciation_account_id != null
      ? `NSACCT-${ns.depreciation_account_id}`
      : "UNRESOLVED");
  const accumAcct =
    resolveAcct(ns.accumulated_depr_account_id) ??
    (ns.accumulated_depr_account_id != null
      ? `NSACCT-${ns.accumulated_depr_account_id}`
      : "UNRESOLVED");

  return {
    code: nsFixedAssetCode(ns.id),
    description: ns.description || ns.name || `Asset ${ns.id}`,
    category: ns.asset_type ?? null,
    entityCode: opts.entityCode ?? null,
    vendorPartyCode: opts.vendorPartyCode ?? null,
    acquisitionDate: String(ns.acquisition_date).slice(0, 10),
    acquisitionCost: Number(ns.original_cost ?? 0),
    acquisitionCurrencyCode: opts.acquisitionCurrencyCode ?? "USD",
    status: mappedStatus,
    disposalDate: ns.disposal_date
      ? String(ns.disposal_date).slice(0, 10)
      : null,
    disposalProceeds:
      ns.disposal_amount != null ? Number(ns.disposal_amount) : null,
    assetAccountCode: assetAcct,
    bookAttributes: [
      {
        bookCode: opts.bookCode,
        usefulLifeMonths: Number(ns.useful_life_months ?? 0),
        depreciationMethod: mappedMethod,
        inServiceDate: String(
          ns.placed_in_service_date ?? ns.acquisition_date
        ).slice(0, 10),
        salvageValue: Number(ns.residual_value ?? 0),
        accumulatedDepreciation: Number(ns.accumulated_depreciation ?? 0),
        depreciationExpenseAccountCode: depAcct,
        accumDepreciationAccountCode: accumAcct,
        ...(unmappedNote ? { unmappedMethodNote: unmappedNote } : {}),
      },
    ],
    extensions: {
      ...(ns.custodian_id != null ? { custodianId: ns.custodian_id } : {}),
      ...(ns.location_id != null ? { locationId: ns.location_id } : {}),
      ...(ns.current_book_value != null
        ? { currentBookValueAtImport: Number(ns.current_book_value) }
        : {}),
      ...(ns.gain_loss != null ? { gainLoss: Number(ns.gain_loss) } : {}),
    },
    sourceSystem: "NETSUITE",
    sourceRecordType: "FixedAsset",
    sourceRecordId: String(ns.id),
    sourcePayload: ns,
    mappingVersion,
  };
}

/**
 * Batch helper — maps an array of NetSuite assets in one call.
 * Surfaces unmapped-method counts so the caller can warn the user
 * before kicking off a real import.
 */
export function mapNsFixedAssets(
  assets: NsFixedAsset[],
  opts: MapNsFixedAssetOptions
): {
  mapped: MappedFixedAsset[];
  unmappedMethodCounts: Record<string, number>;
  unrecognizedStatuses: Record<string, number>;
} {
  const mapped: MappedFixedAsset[] = [];
  const unmappedMethodCounts: Record<string, number> = {};
  const unrecognizedStatuses: Record<string, number> = {};

  for (const ns of assets) {
    const m = mapNsFixedAsset(ns, opts);
    mapped.push(m);
    const ba = m.bookAttributes[0]!;
    if (ba.unmappedMethodNote) {
      const key = String(ns.depreciation_method ?? "");
      unmappedMethodCounts[key] = (unmappedMethodCounts[key] ?? 0) + 1;
    }
    if (!STATUS_MAP[ns.status]) {
      unrecognizedStatuses[ns.status] =
        (unrecognizedStatuses[ns.status] ?? 0) + 1;
    }
  }

  return { mapped, unmappedMethodCounts, unrecognizedStatuses };
}
