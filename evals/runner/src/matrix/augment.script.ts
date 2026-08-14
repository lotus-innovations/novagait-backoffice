// Adds the cache-cadence table and the spend reconciliation to a finished
// matrix directory.
//
// Why this is a separate step rather than inline: the accounting rules landed
// while a paid run was already in flight, and restarting to pick them up would
// have thrown away the lane in progress. Both sections are pure functions over
// the ledger and the artifacts, so applying them afterwards produces exactly
// what an inline run would have written. Future runs call the same functions
// from run.script.ts; this script exists so THIS run does not have to be
// re-paid for.
//
// Key-free: reads and rewrites local files only.
//
//   npm run -w @novagait/evals-runner matrix:augment
//
// SUPERSEDED_BEFORE (ISO timestamp) marks ledger entries from an abandoned
// attempt: any batch whose entries all predate it is treated as superseded.

import { readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  cacheStatsByLane,
  reconcileSpend,
  renderAugmentedReadme,
  renderCacheSection,
  renderSpendSection,
} from "./accounting";
import {
  costUsd,
  pricingAlias,
  recomputeTotals,
  renderLedgerSnapshot,
  type LedgerFile,
} from "./ledger";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const RESULTS_DIR =
  process.env.MATRIX_RESULTS_DIR ??
  join(REPO, "evals/results/matrix-2026-08-11");
const LEDGER_PATH = join(REPO, "evals/results/spend-ledger-2026-08-11.json");
const SUPERSEDED_BEFORE = process.env.SUPERSEDED_BEFORE ?? "";

/**
 * Records billed usage the run never read.
 *
 * A batch cancelled for stalling can still complete requests during the
 * cancellation window: one was observed ending with 13 succeeded and 3
 * cancelled. Those 13 were billed, but the driver had already moved to the
 * resubmission and never read them, so they are absent from the ledger. The
 * envelope must reflect money actually spent, not money whose results were
 * useful, so they are swept up here.
 */
async function sweepUnrecordedSpend(ledger: LedgerFile): Promise<number> {
  if (process.env.MATRIX_SWEEP !== "1") return 0;
  const client = new Anthropic();
  const known = new Set(ledger.entries.map((entry) => entry.key));
  let added = 0;
  for await (const batch of client.messages.batches.list({ limit: 100 })) {
    if (batch.processing_status !== "ended") continue;
    if ((batch.request_counts.succeeded ?? 0) === 0) continue;
    const stream = await client.messages.batches.results(batch.id);
    for await (const row of stream) {
      const key = `${batch.id}:${row.custom_id}`;
      if (known.has(key)) continue;
      const result = row.result as {
        type: string;
        message?: { usage?: Record<string, number>; model?: string };
      };
      if (result.type !== "succeeded" || !result.message?.usage) continue;
      const usage = result.message.usage;
      // The echoed model is a dated snapshot; store the alias so a swept entry
      // groups with the lane that paid for it. No default: a result with no
      // model is unattributable, and guessing one would misreport the envelope.
      if (result.message.model === undefined) {
        throw new Error(
          `sweep: batch ${batch.id} result ${row.custom_id} has no model`,
        );
      }
      const model = pricingAlias(result.message.model);
      const tokens = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      };
      ledger.entries.push({
        key,
        lane: "unrecorded:swept",
        model,
        channel: "batch",
        write_ttl: null,
        case_id: row.custom_id,
        round: null,
        usage: tokens,
        // Priced with the same function the ledger uses, so a swept entry is
        // indistinguishable in cost terms from one recorded during the run.
        cost_usd: costUsd({
          model,
          usage: tokens,
          channel: "batch",
          writeTtl: null,
        }),
        recorded_at: new Date().toISOString(),
      });
      added += 1;
    }
  }
  return added;
}

test("augment matrix artifacts with cache and spend accounting", async () => {
  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as LedgerFile;
  // Derived, never trusted from disk, for the same reason SpendLedger.open
  // derives them: a totals block read off a file is a claim about the entries,
  // and everything below publishes it.
  ledger.totals = recomputeTotals(ledger.entries);
  const swept = await sweepUnrecordedSpend(ledger);
  if (swept > 0) {
    // Refresh the whole totals block, not just the scalar fields: a partial
    // update leaves by_lane/by_model/by_channel contradicting the total.
    ledger.totals = recomputeTotals(ledger.entries);
    await writeFile(
      LEDGER_PATH,
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `swept ${swept} billed-but-unread results into the ledger; ` +
        `total now $${ledger.totals.cost_usd.toFixed(4)}`,
    );
  }

  const matrixPath = join(RESULTS_DIR, "matrix.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8")) as Record<
    string,
    unknown
  > & { lanes?: { key: string }[] };

  // Spend is published only if it belongs to a lane that survived INTO this
  // matrix. Time alone cannot express that: a lane can fail after the cutoff
  // (opus:cached failed on the last attempt of the run) and its spend is just
  // as superseded as the abandoned first attempt's. Deriving the set from the
  // matrix's own lanes is what reconcileSpend's contract already asks for -
  // "the batch ids the surviving lanes and judge passes actually used" - and
  // without it a run whose later lanes failed reports their spend as published.
  const laneKeys = new Set(
    ((matrix.lanes ?? []) as { key: string }[]).map((lane) => lane.key),
  );
  const isPublishedLane = (lane: string): boolean =>
    laneKeys.has(lane) ||
    lane.startsWith("judge:") ||
    lane.startsWith("latency:");

  // Batch-exact attribution, preferred over lane name. A lane can appear TWICE
  // in one ledger - claude-opus-5:cached was attempted, killed by credit
  // exhaustion, and re-run - and a lane-name rule then reports the dead
  // attempt's spend as published because the name matches. Each lane's
  // checkpoint carries the batch ids of the attempt that was actually
  // published, so those ids are the authority; lane name is the fallback for
  // a lane whose checkpoint predates the field.
  const attributed = new Set<string>();
  const lanesWithBatchIds = new Set<string>();
  for (const lane of laneKeys) {
    const path = join(RESULTS_DIR, `checkpoint-${lane.replace(":", "-")}.json`);
    const checkpoint = await readFile(path, "utf8").then(
      (raw) => JSON.parse(raw) as { batch_ids?: string[] },
      () => null,
    );
    if (checkpoint?.batch_ids === undefined) continue;
    lanesWithBatchIds.add(lane);
    for (const id of checkpoint.batch_ids) attributed.add(id);
  }

  const published = new Set<string>();
  const superseded = new Set<string>();
  for (const entry of ledger.entries) {
    if (entry.key.endsWith(":reconciled")) continue;
    const batchId = entry.key.split(":")[0];
    const afterCutoff =
      SUPERSEDED_BEFORE === "" || entry.recorded_at >= SUPERSEDED_BEFORE;
    const isPublished = lanesWithBatchIds.has(entry.lane)
      ? attributed.has(batchId)
      : afterCutoff && isPublishedLane(entry.lane);
    if (isPublished) {
      published.add(batchId);
    } else {
      superseded.add(batchId);
    }
  }
  for (const id of published) superseded.delete(id);
  console.log(
    `attribution: ${lanesWithBatchIds.size} of ${laneKeys.size} lanes attributed ` +
      `by batch id (${attributed.size} batches); the rest by lane name` +
      (SUPERSEDED_BEFORE === "" ? "" : ` with cutoff ${SUPERSEDED_BEFORE}`),
  );

  const cache = cacheStatsByLane(ledger, published);
  const spend = reconcileSpend(ledger, published);

  matrix.cache_accounting = cache;
  matrix.spend_reconciliation = spend;
  // Re-rendered from the ledger file, not left as the run wrote it: the sweep
  // above appends real spend, and an embedded snapshot that predates it makes
  // the matrix disagree with its own reconciliation table.
  matrix.ledger = renderLedgerSnapshot(ledger);
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");

  const readmePath = join(RESULTS_DIR, "README.md");
  const readme = await readFile(readmePath, "utf8");
  const sections = [renderCacheSection(cache), renderSpendSection(spend)]
    .filter((section) => section !== "")
    .join("\n");
  await writeFile(
    readmePath,
    renderAugmentedReadme(readme, ledger, sections),
    "utf8",
  );

  console.log(
    `augmented ${RESULTS_DIR}: ${cache.length} lanes, ` +
      `published $${spend.published_usd.toFixed(4)}, ` +
      `superseded $${spend.superseded.reduce((a, s) => a + s.cost_usd, 0).toFixed(4)}, ` +
      `reconciles=${spend.reconciles}`,
  );
  expect(spend.reconciles).toBe(true);
});
