// Process-wide runtime singletons for the web app. Store driver selection
// (Upstash in prod, in-memory elsewhere) lives in @novagait/agent.
//
// Anchored on globalThis deliberately: Next.js bundles pages and route
// handlers as separate module graphs, so a module-level singleton would
// give each bundle its OWN in-memory store (pages would never see runs the
// API created). Redis in production is external and unaffected; this makes
// the in-memory driver behave the same way.

import { createStore, type Store } from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";

interface RuntimeGlobals {
  __novagaitStore?: Store;
  __novagaitBackend?: MockBackend;
  __novagaitSeeded?: boolean;
}

const globals = globalThis as RuntimeGlobals;

export function getStore(): Store {
  globals.__novagaitStore ??= createStore();
  return globals.__novagaitStore;
}

export function getBackend(): MockBackend {
  globals.__novagaitBackend ??= new MockBackend(getStore(), { jitter: true });
  return globals.__novagaitBackend;
}

// Seed once per process if the backend is empty (dev / in-memory runtime).
// Production seeding is owned by the nightly reset (LOT-92).
export async function ensureSeeded(): Promise<void> {
  if (globals.__novagaitSeeded) return;
  const vendors = await getBackend().listVendors();
  if (vendors.length === 0) await getBackend().seed();
  globals.__novagaitSeeded = true;
}
