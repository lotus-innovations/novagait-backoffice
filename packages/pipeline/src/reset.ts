// Nightly demo reset (LOT-92, spec 11 §1): restore seed state, clear
// runs/traces/approvals, reset vendor profiles, dedupe ledger, and the
// failure toggle. The Store interface has no key scan by design, so every
// surface is enumerated from known indexes:
//   runs           -> runs:recent (capped at 200; older keys expire via TTL)
//   approvals      -> approval:by-run:{run_id} -> approval:{id}
//   vendor profiles-> the seeded vendor ids (the only ids that can exist)
//   dedupe ledger  -> contentDigest of every fixture (intake is
//                     seeded-documents-only per spec 13, so these are the
//                     only digests that can exist)
// The budget counter named in spec 11 §1 does not exist yet; it arrives
// with the live-spend lane and joins this list then.

import { contentDigest, traceKeys, type Store } from "@novagait/agent";
import { FIXTURES, MockBackend, VENDORS } from "@novagait/mock-backend";

export interface ResetSummary {
  runs_cleared: number;
  vendor_profiles_cleared: number;
  dedupe_entries_cleared: number;
  reseeded: true;
}

export async function resetDemo(store: Store): Promise<ResetSummary> {
  const runIds = await store.listRange(traceKeys.recent(), 0, -1);
  const keys: string[] = [];
  for (const runId of runIds) {
    keys.push(
      traceKeys.trace(runId),
      traceKeys.run(runId),
      `runstate:${runId}`,
    );
    const approvalId = await store.get(`approval:by-run:${runId}`);
    if (approvalId) keys.push(`approval:${approvalId}`);
    keys.push(`approval:by-run:${runId}`);
  }
  keys.push(traceKeys.recent());

  const vendorKeys = VENDORS.map((vendor) => `vendor:${vendor.id}`);
  const dedupeKeys = [
    ...new Set(Object.values(FIXTURES).map((text) => contentDigest(text))),
  ].map((digest) => `seen:${digest}`);

  await store.del([...keys, ...vendorKeys, ...dedupeKeys]);

  // seed() overwrites every backend key, including the failure toggle.
  await new MockBackend(store).seed();

  return {
    runs_cleared: runIds.length,
    vendor_profiles_cleared: vendorKeys.length,
    dedupe_entries_cleared: dedupeKeys.length,
    reseeded: true,
  };
}
