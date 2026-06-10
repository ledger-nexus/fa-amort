// Per-tenant role-based access control policy. Mirror of ledger-core's
// src/lib/auth/policy.ts — same hierarchy, same named permissions.
//
// fa-amort's actions: run depreciation, classify capex / useful-life /
// impairment via AI, accept/reject suggestions. All MEMBER+. The AI
// budget cap CHANGES (a future admin surface) will be ADMIN+ when it
// ships — canManageAiBudget is here ready.

import type { TenantRole } from "@prisma/client";

const ROLE_RANK: Record<TenantRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

function meets(actual: TenantRole | undefined | null, required: TenantRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// READ
export const canViewReports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "VIEWER");

// WRITE — MEMBER+ for depreciation runs + AI classifiers + accept/reject.
export const canRunDepreciation = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canClassifyWithAi = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canDecideAiSuggestion = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// ADMIN — for future AI budget config / admin surfaces.
export const canManageAiBudget = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export const canViewAdminPages = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: string, public readonly role: TenantRole | null) {
    super(
      role
        ? `This action requires a higher role than ${role}. (permission: ${permission})`
        : `This action requires being signed in to a tenant. (permission: ${permission})`
    );
    this.name = "PermissionDeniedError";
  }
}

export function requirePermission(
  permission: string,
  role: TenantRole | null,
  check: (r: TenantRole | null) => boolean
): void {
  if (!check(role)) throw new PermissionDeniedError(permission, role);
}
