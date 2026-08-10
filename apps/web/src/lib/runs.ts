// Read-side helpers for the run viewer (spec 08 §5-6). Pure reads over the
// Store; no mutation from these paths, ever.

import {
  readTrace,
  traceKeys,
  type Store,
  type TraceEvent,
} from "@novagait/agent";

export interface RunSummary {
  run_id: string;
  mode: string;
  model: string;
  input_ref: string;
  outcome: string | null;
  total_cost_micro_usd: number | null;
  iteration_count: number | null;
  started_at: string | null;
  ended_at: string | null;
}

function toSummary(runId: string, hash: Record<string, string>): RunSummary {
  return {
    run_id: runId,
    mode: hash.mode ?? "?",
    model: hash.model ?? "?",
    input_ref: hash.input_ref ?? "?",
    outcome: hash.outcome ?? null,
    total_cost_micro_usd: hash.total_cost_micro_usd
      ? Number(hash.total_cost_micro_usd)
      : null,
    iteration_count: hash.iteration_count ? Number(hash.iteration_count) : null,
    started_at: hash.started_at ?? null,
    ended_at: hash.ended_at ?? null,
  };
}

export async function listRecentRuns(store: Store): Promise<RunSummary[]> {
  const ids = await store.listRange(traceKeys.recent(), 0, -1);
  const summaries: RunSummary[] = [];
  // Newest first: the index is append-order.
  for (const runId of [...ids].reverse()) {
    const hash = await store.hgetall(traceKeys.run(runId));
    if (hash) summaries.push(toSummary(runId, hash));
  }
  return summaries;
}

export async function getRunSummary(
  store: Store,
  runId: string,
): Promise<RunSummary | null> {
  const hash = await store.hgetall(traceKeys.run(runId));
  return hash ? toSummary(runId, hash) : null;
}

export async function getRunTrace(
  store: Store,
  runId: string,
): Promise<TraceEvent[]> {
  return readTrace(store, runId);
}

export function formatMicroUsd(micro: number | null): string {
  if (micro === null) return "-";
  return `$${(micro / 1_000_000).toFixed(6)}`;
}
