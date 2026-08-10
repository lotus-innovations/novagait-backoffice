// Read-side helpers for the /memory page (LOT-100, arch doc E): the three
// named stores rendered as plain tables. Pure reads over the Store; the
// same enumeration strategy as the nightly reset (no key scan).

import {
  RunStateMachine,
  VendorProfileStore,
  contentDigest,
  traceKeys,
  type RunStateRecord,
  type Store,
  type VendorProfile,
} from "@novagait/agent";
import { FIXTURES, VENDORS } from "@novagait/mock-backend";

export interface VendorProfileRow extends VendorProfile {
  vendor_id: string;
}

export interface DedupeRow {
  digest: string;
  fixture: string;
  run_id: string;
}

/** Run state records for every run in the recent index, newest first. */
export async function listRunStates(store: Store): Promise<RunStateRecord[]> {
  const ids = await store.listRange(traceKeys.recent(), 0, -1);
  const records: RunStateRecord[] = [];
  for (const runId of [...ids].reverse()) {
    const machine = await RunStateMachine.load(store, runId);
    if (machine) records.push(machine.state);
  }
  return records;
}

/** Profiles for the seeded vendors that have accumulated memory. */
export async function listVendorProfiles(
  store: Store,
): Promise<VendorProfileRow[]> {
  const profiles = new VendorProfileStore(store);
  const rows: VendorProfileRow[] = [];
  for (const vendor of VENDORS) {
    const profile = await profiles.get(vendor.id);
    if (profile) rows.push({ vendor_id: vendor.id, ...profile });
  }
  return rows;
}

/**
 * Recorded dedupe entries. Intake is seeded-documents-only (spec 13), so
 * the fixture digests enumerate every entry that can exist.
 */
export async function listDedupeEntries(store: Store): Promise<DedupeRow[]> {
  const rows: DedupeRow[] = [];
  for (const [fixture, text] of Object.entries(FIXTURES)) {
    const digest = contentDigest(text);
    const runId = await store.get(`seen:${digest}`);
    if (runId) rows.push({ digest, fixture, run_id: runId });
  }
  return rows.sort((a, b) => a.fixture.localeCompare(b.fixture));
}
