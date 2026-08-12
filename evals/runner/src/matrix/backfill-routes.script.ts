// Recovers the model-proposed route for lanes whose checkpoints predate the
// field, from the batch results the API still holds. Zero new spend: reading
// a finished batch's results is free, and nothing here submits a request.
//
// Why it exists: the divergence column published 0 for all three lanes of the
// 2026-08-11 matrix because the join read proposals out of a process-local
// map that only has entries for cases run in THAT invocation, and every
// published lane was resumed from a checkpoint. The proposal itself was never
// lost - it is the `route` argument the model passed to `draft_action`, which
// is sitting in the stored batch result. This reads it back.
//
//   npm run -w @novagait/evals-runner matrix:backfill-routes
//
// A lane's ledger may contain more than one attempt (the haiku lanes were run
// twice). Batches are walked in creation order and the LAST attempt - the one
// whose checkpoint was published - wins, which the round-reset boundary makes
// explicit. The per-case result count of that attempt is asserted against the
// checkpoint's own `iterations`, so a wrong attempt cannot pass silently.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";
import type { RunOutcome } from "../outcome";
import type { CaseRunRecord } from "./batch";
import type { LedgerFile } from "./ledger";
import { laneDivergence } from "./results";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const RESULTS_DIR =
  process.env.MATRIX_RESULTS_DIR ??
  join(REPO, "evals/results/matrix-2026-08-11");
const LEDGER_PATH = join(REPO, "evals/results/spend-ledger-2026-08-11.json");

interface Checkpoint {
  outcomes: RunOutcome[];
  records: CaseRunRecord[];
  /** Batches the PUBLISHED attempt used; see the reconciliation note below. */
  batch_ids?: string[];
}

/**
 * The `route` the model asked for on its LAST draft_action of a message.
 *
 * Only messages that stopped ON a tool call count. A message truncated by
 * max_tokens can end mid-`draft_action`, and the SDK still exposes whatever
 * of the arguments it managed to parse - but the driver never executes a
 * truncated turn, so nothing was traced and the canonical `modelRouteFrom`
 * would return null for it. Counting it here would invent proposals the
 * published definition does not have: on the opus lane that alone accounted
 * for 22 fabricated divergences.
 */
function proposedRoute(message: Anthropic.Messages.Message): string | null {
  if (message.stop_reason !== "tool_use") return null;
  let route: string | null = null;
  for (const block of message.content) {
    if (block.type !== "tool_use" || block.name !== "draft_action") continue;
    const input = block.input as { route?: unknown };
    if (typeof input.route === "string") route = input.route;
  }
  return route;
}

test("backfill model_route into published checkpoints", async () => {
  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as LedgerFile;
  const client = new Anthropic();

  // batch id -> lane and round, straight off the ledger the run wrote.
  const laneOf = new Map<string, string>();
  const roundOf = new Map<string, number>();
  for (const entry of ledger.entries) {
    if (entry.channel !== "batch") continue;
    if (entry.lane === "unrecorded:swept") continue;
    const batchId = entry.key.split(":")[0];
    laneOf.set(batchId, entry.lane);
    if (entry.round !== null) roundOf.set(batchId, entry.round);
  }

  const lanes = [...new Set(laneOf.values())];
  const report: string[] = [];

  for (const lane of lanes) {
    const path = join(
      RESULTS_DIR,
      `checkpoint-${lane.replace(":", "-")}.json`,
    );
    const checkpoint = await readFile(path, "utf8").then(
      (raw) => JSON.parse(raw) as Checkpoint,
      () => null,
    );
    if (checkpoint === null) continue;

    const laneBatches = [...laneOf.entries()]
      .filter(([, value]) => value === lane)
      .map(([batchId]) => batchId);
    const created = new Map<string, string>();
    for (const batchId of laneBatches) {
      const batch = await client.messages.batches.retrieve(batchId);
      created.set(batchId, batch.created_at);
    }
    const ordered = laneBatches.sort((a, b) =>
      (created.get(a) ?? "").localeCompare(created.get(b) ?? ""),
    );

    // An attempt restarts at round 0; the published checkpoint is the last
    // attempt, so everything before the final round-0 batch is a superseded
    // run and must not contribute a proposal.
    const zeroRounds = ordered
      .map((batchId, index) => ({ batchId, index }))
      .filter(({ batchId }) => roundOf.get(batchId) === 0)
      .map(({ index }) => index);
    // Consecutive round-0 batches are the chunks of ONE round 0, so an attempt
    // boundary is a round-0 batch that does not directly follow another.
    const boundaries = zeroRounds.filter(
      (index, position) =>
        position === 0 || zeroRounds[position - 1] !== index - 1,
    );
    const start =
      boundaries.length === 0 ? 0 : boundaries[boundaries.length - 1];

    const proposals = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const batchId of ordered.slice(start)) {
      const stream = await client.messages.batches.results(batchId);
      for await (const row of stream) {
        const result = row.result as {
          type: string;
          message?: Anthropic.Messages.Message;
        };
        if (result.type !== "succeeded" || result.message === undefined)
          continue;
        seen.set(row.custom_id, (seen.get(row.custom_id) ?? 0) + 1);
        const route = proposedRoute(result.message);
        if (route !== null) proposals.set(row.custom_id, route);
      }
    }

    // The attempt we picked must be the one the checkpoint came from: its
    // per-case request count has to match the recorded iteration count.
    const mismatched = checkpoint.records.filter(
      (record) => (seen.get(record.case_id) ?? 0) !== record.iterations,
    );
    expect(
      mismatched.map((record) => record.case_id),
      `${lane}: recovered attempt does not match the checkpoint's iterations`,
    ).toEqual([]);

    const before = laneDivergence({
      lane,
      records: checkpoint.records,
      outcomes: checkpoint.outcomes,
    });
    // Canonical semantics: `modelRouteFrom` reads the TRACE, so a proposal
    // only exists if the driver actually executed the draft_action. A call
    // whose arguments failed the tool schema is answered with an is_error
    // tool_result and never traced (INV-037 on the haiku lane did exactly
    // that: the model drafted `reject`, the args did not validate, and the
    // run ended held with `no_draft_action`). Recovering it from the raw
    // result would count a proposal the published column never had.
    const traced = new Set(
      checkpoint.outcomes
        .filter((outcome) => outcome.tool_calls.includes("draft_action"))
        .map((outcome) => outcome.case_id),
    );
    checkpoint.records = checkpoint.records.map((record) => ({
      ...record,
      // Authoritative: the per-case count assertion above proves every
      // message of the published attempt was read, so "no proposal found"
      // means the run really never traced one.
      model_route: traced.has(record.case_id)
        ? (proposals.get(record.case_id) ?? null)
        : null,
    }));
    const after = laneDivergence({
      lane,
      records: checkpoint.records,
      outcomes: checkpoint.outcomes,
    });
    // Reconciliation needs the batch ids of the attempt that was actually
    // published. Lane name is not enough once a lane is re-run: the
    // claude-opus-5:cached lane exists twice in this ledger, once as the
    // attempt that died on credit exhaustion and once as the attempt that
    // succeeded, and a lane-name rule would report the dead one's spend as
    // published. The attempt boundary computed above, already validated
    // against the checkpoint's own iteration counts, is the exact answer.
    checkpoint.batch_ids = ordered.slice(start);
    await writeFile(
      path,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      "utf8",
    );
    report.push(
      `${lane}: ${proposals.size}/${checkpoint.records.length} proposals ` +
        `recovered from ${ordered.length - start} batches (of ${ordered.length} ` +
        `the lane name covers), divergence ` +
        `${before === null ? "null" : before} -> ${after === null ? "null" : after}`,
    );
  }

  for (const line of report) console.log(line);
  expect(report.length).toBeGreaterThan(0);
});
