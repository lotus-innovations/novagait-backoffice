// Shared between playwright.config.ts (which injects them into the server
// environment) and the specs (which authenticate against them). The demo
// has no keys of any kind: these are test-lane secrets for the admin and
// maintenance routes only.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3123);
// localhost, not 127.0.0.1: `next start` normalizes request.url to
// localhost, and the same-origin guard (apps/web/src/lib/origin.ts) compares
// the browser Origin against that host - a 127.0.0.1 baseURL makes every
// form POST look cross-origin and 403.
export const BASE_URL = `http://localhost:${E2E_PORT}`;

export const E2E_ADMIN_KEY = "e2e-admin-key";
export const E2E_CRON_SECRET = "e2e-cron-secret";

// Seeded inbox documents, verified against the running mock lane
// (packages/mock-backend/src/seed-data.ts INBOX_SEED order).
export const DOC = {
  // Full match, known vendor, under the $500 autonomy cap -> auto_approve.
  corvidaMonthly: "INB-001",
  brightlineSupplies: "INB-002",
  peloraCleaning: "INB-003", // minor exception -> route_for_approval
  corvidaReporting: "INB-005",
  brightlineDisputeNote: "INB-012",
  // >= $5,000 hard floor and above the autonomy cap -> route_for_approval.
  peloraRenovation: "INB-013",
} as const;
