// Cassette recorder (LOT-106). Drives every golden case through the MOCK
// pipeline (key-free, no model, no network) and writes one cassette per case.
// Runnable as `npm run -w @novagait/evals-runner cassettes:record`.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InMemoryStore,
  PROMPT_VERSION,
  RunStateMachine,
  TOOLS_VERSION,
  extractionSchema,
  readTrace,
  type Store,
} from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { MOCK_MODEL_ID, runMockPipeline } from "@novagait/pipeline";
import { loadGoldenCases, type GoldenCase } from "../golden";
import { fromTraceEvents, type RunOutcome } from "../outcome";
import {
  CASSETTE_LANE,
  CASSETTE_PIPELINE,
  CASSETTE_VERSION,
  cassetteFileName,
  normalizeOutcome,
  serializeCassette,
  type Cassette,
} from "./cassette";
import { CASSETTE_DIR, GOLDEN_DIR } from "./paths";

// Autonomous is the only mode that records the full lane: an auto_approve
// case must reach the ledger for INV-010's duplicate to be detectable at all.
export const RECORD_MODE = "autonomous";

// MockBackend deliberately exposes no "enqueue" API (the demo inbox is
// seeded), and eval fixtures are fixture-map-only by CASE-PLAN, so the
// recorder writes the inbox index directly. Same key the backend uses.
const INBOX_ITEMS_KEY = "inbox:items";
const ENQUEUED_AT = "2026-08-10T00:00:00.000Z";

// Cases whose expected behaviour depends on a PRIOR run's ERP state. INV-010
// holds on GR-DUP because INV-001 posted CB-2026-0803 to the ledger; every
// other duplicate case (057-060) hits a seeded LEDGER_HISTORY row and needs
// no predecessor. Recording is otherwise fresh-per-case (README, ordering).
export const PRE_SEED_RUNS: Record<string, string[]> = {
  "INV-010": ["INV-001"],
};

async function enqueue(
  store: Store,
  itemId: string,
  fixture: string,
): Promise<void> {
  const raw = await store.get(INBOX_ITEMS_KEY);
  const items = raw === null ? [] : (JSON.parse(raw) as unknown[]);
  items.push({ id: itemId, fixture, received_at: ENQUEUED_AT, state: "new" });
  await store.set(INBOX_ITEMS_KEY, JSON.stringify(items));
}

async function runOne(
  store: Store,
  backend: MockBackend,
  goldenCase: GoldenCase,
): Promise<RunOutcome> {
  const itemId = `EVAL-${goldenCase.id}`;
  await enqueue(store, itemId, goldenCase.input.fixture);
  const result = await runMockPipeline({
    store,
    backend,
    inboxItemId: itemId,
    mode: RECORD_MODE,
  });

  const events = await readTrace(store, result.runId);
  const machine = await RunStateMachine.load(store, result.runId);
  const rawExtraction = machine?.state.data.extraction;
  const parsed =
    rawExtraction === undefined
      ? null
      : extractionSchema.safeParse(rawExtraction);

  const outcome = fromTraceEvents(events, {
    case_id: goldenCase.id,
    // The mock lane traces only { route, summary } on draft_action and keeps
    // the extraction in the run store, so the adapter is fed the fields from
    // there (outcome.ts documents this split).
    fields: parsed?.success
      ? {
          vendor_id: parsed.data.vendor_id,
          vendor_name_raw: parsed.data.vendor_name_raw,
          invoice_number: parsed.data.invoice_number,
          invoice_date: parsed.data.invoice_date,
          due_date: parsed.data.due_date,
          total_cents: parsed.data.total_cents,
          currency: parsed.data.currency,
          po_reference: parsed.data.po_reference,
        }
      : {},
    // A GR-SCOPE rejection happens before extraction: there is no structured
    // invoice to validate and the disposition is a rejection note, so the
    // schema check is satisfied rather than failed.
    output_schema_valid: parsed ? parsed.success : result.route === "reject",
  });

  return {
    ...outcome,
    // GR-SCOPE rejects without a draft_action event, so the route the
    // pipeline actually took is the only record of the decision.
    decision: outcome.decision ?? (result.route as RunOutcome["decision"]),
  };
}

export function toCassette(outcome: RunOutcome, caseId: string): Cassette {
  return {
    version: CASSETTE_VERSION,
    case_id: caseId,
    lane: CASSETTE_LANE,
    pipeline: CASSETTE_PIPELINE,
    recorded_with: {
      prompt_version: PROMPT_VERSION,
      tools_version: TOOLS_VERSION,
      model: MOCK_MODEL_ID,
      mode: RECORD_MODE,
    },
    outcome: normalizeOutcome(outcome, caseId),
  };
}

export async function recordCase(
  goldenCase: GoldenCase,
  byId: Map<string, GoldenCase>,
): Promise<Cassette> {
  const store = new InMemoryStore();
  const backend = new MockBackend(store);
  await backend.seed();

  for (const predecessorId of PRE_SEED_RUNS[goldenCase.id] ?? []) {
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      throw new Error(
        `${goldenCase.id}: pre-seed case ${predecessorId} is not in the golden set`,
      );
    }
    await runOne(store, backend, predecessor);
  }

  return toCassette(await runOne(store, backend, goldenCase), goldenCase.id);
}

export interface RecordOptions {
  goldenDir?: string;
  outDir?: string;
  // Remove cassettes with no golden case behind them (default true).
  prune?: boolean;
}

export async function recordCassettes(
  options: RecordOptions = {},
): Promise<Cassette[]> {
  const goldenDir = options.goldenDir ?? GOLDEN_DIR;
  const outDir = options.outDir ?? CASSETTE_DIR;
  const cases = await loadGoldenCases(goldenDir);
  const byId = new Map(cases.map((entry) => [entry.id, entry]));

  await mkdir(outDir, { recursive: true });
  const cassettes: Cassette[] = [];
  for (const goldenCase of cases) {
    const cassette = await recordCase(goldenCase, byId);
    await writeFile(
      join(outDir, cassetteFileName(cassette.case_id)),
      serializeCassette(cassette),
      "utf8",
    );
    cassettes.push(cassette);
  }

  if (options.prune !== false) {
    const expected = new Set(cases.map((entry) => cassetteFileName(entry.id)));
    for (const name of await readdir(outDir)) {
      if (name.endsWith(".json") && !expected.has(name)) {
        await rm(join(outDir, name));
      }
    }
  }
  return cassettes;
}
