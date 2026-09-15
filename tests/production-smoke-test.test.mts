import test from "node:test";
import assert from "node:assert/strict";

/**
 * VECTA Production Smoke Test Suite & Route Registry
 *
 * Classifies all critical operational workflows into:
 * - READ_ONLY: Safe for automated health monitoring & smoke testing in production.
 * - SAFE_MUTATION: Deterministic, reversible state changes (e.g., mark notification read).
 * - MANUAL_DO_NOT_AUTO_RUN: Immutable security reports (SEC013-033), actual attendance,
 *   permanent approvals, and driver transactions.
 */

export interface SmokeTestRoute {
  name: string;
  path: string;
  classification: "READ_ONLY" | "SAFE_MUTATION" | "MANUAL_DO_NOT_AUTO_RUN";
  expectedRoles: string[];
  description: string;
}

export const SMOKE_TEST_REGISTRY: SmokeTestRoute[] = [
  {
    name: "Health Endpoint",
    path: "/api/health",
    classification: "READ_ONLY",
    expectedRoles: ["public"],
    description: "System health, database connectivity check",
  },
  {
    name: "Root Dashboard",
    path: "/",
    classification: "READ_ONLY",
    expectedRoles: ["aso", "so", "dse", "management", "enforcement", "admin"],
    description: "Main operational command landing page",
  },
  {
    name: "Duty Screen",
    path: "/avsec/duty",
    classification: "READ_ONLY",
    expectedRoles: ["aso", "so", "dse"],
    description: "Check-in/out station & shift gate interface",
  },
  {
    name: "Overtime Review",
    path: "/avsec/duty/overtime",
    classification: "READ_ONLY",
    expectedRoles: ["dse", "management", "admin"],
    description: "Automatic overtime calculation & endorsement view",
  },
  {
    name: "Bay Board",
    path: "/avsec/bay-board",
    classification: "READ_ONLY",
    expectedRoles: ["aso", "so", "dse", "management", "enforcement", "admin"],
    description: "Real-time aircraft ground time & search tracker",
  },
  {
    name: "Flight Detail",
    path: "/avsec/flights",
    classification: "READ_ONLY",
    expectedRoles: ["aso", "so", "dse", "management", "enforcement", "admin"],
    description: "Flight security overview",
  },
  {
    name: "Shift Handover History",
    path: "/avsec/duty/handover",
    classification: "READ_ONLY",
    expectedRoles: ["so", "dse", "management", "admin"],
    description: "Branch-isolated shift handover log",
  },
  {
    name: "SEC Report Search & Lookup",
    path: "/avsec/reports/lookup",
    classification: "READ_ONLY",
    expectedRoles: ["aso", "so", "dse", "management", "enforcement", "admin"],
    description: "Historical security report search",
  },
  {
    name: "ICMS Dashboard",
    path: "/icms/dashboard",
    classification: "READ_ONLY",
    expectedRoles: ["vendor", "management", "admin"],
    description: "CaterLink and ICMS active delivery portal",
  },
  {
    name: "ICMS Transaction List",
    path: "/icms/transactions",
    classification: "READ_ONLY",
    expectedRoles: ["vendor", "management", "admin"],
    description: "Dispatch and seal transaction directory",
  },
  {
    name: "Admin User Directory",
    path: "/avsec/admin/users",
    classification: "READ_ONLY",
    expectedRoles: ["management", "admin"],
    description: "Staff and driver account registry",
  },
  {
    name: "SEC014 Submission",
    path: "/avsec/reports/sec014",
    classification: "MANUAL_DO_NOT_AUTO_RUN",
    expectedRoles: ["aso"],
    description: "Immutable ASO daily security report submission",
  },
  {
    name: "SEC016 Submission",
    path: "/avsec/reports/sec016",
    classification: "MANUAL_DO_NOT_AUTO_RUN",
    expectedRoles: ["so", "dse"],
    description: "Immutable aircraft attending search report submission",
  },
  {
    name: "ICMS Part A Transaction Mint",
    path: "/icms/transactions/new",
    classification: "MANUAL_DO_NOT_AUTO_RUN",
    expectedRoles: ["vendor"],
    description: "New catering vehicle dispatch with signature capture",
  },
];

test("Smoke Test Registry: All core modules are classified correctly", () => {
  assert.equal(SMOKE_TEST_REGISTRY.length >= 14, true);

  const readOnlyRoutes = SMOKE_TEST_REGISTRY.filter((r) => r.classification === "READ_ONLY");
  const manualRoutes = SMOKE_TEST_REGISTRY.filter((r) => r.classification === "MANUAL_DO_NOT_AUTO_RUN");

  assert.equal(readOnlyRoutes.length >= 10, true, "Must have comprehensive read-only smoke tests");
  assert.equal(manualRoutes.length >= 3, true, "Immutable reports must be marked MANUAL_DO_NOT_AUTO_RUN");
});

test("Smoke Test Registry: Critical security reports are protected from automated mutation", () => {
  const sec14 = SMOKE_TEST_REGISTRY.find((r) => r.name === "SEC014 Submission");
  const sec16 = SMOKE_TEST_REGISTRY.find((r) => r.name === "SEC016 Submission");
  const icmsPartA = SMOKE_TEST_REGISTRY.find((r) => r.name === "ICMS Part A Transaction Mint");

  assert.equal(sec14?.classification, "MANUAL_DO_NOT_AUTO_RUN");
  assert.equal(sec16?.classification, "MANUAL_DO_NOT_AUTO_RUN");
  assert.equal(icmsPartA?.classification, "MANUAL_DO_NOT_AUTO_RUN");
});
