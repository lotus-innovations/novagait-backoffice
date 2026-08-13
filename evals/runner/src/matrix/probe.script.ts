// Write-liveness probe for the live matrix.
//
// Two blockers stopped the 2026-08-12 run (credit exhaustion, then a
// workspace API usage limit) and both presented as a 400 on SUBMISSION while
// reads kept working. count_tokens is free and proves nothing about billing,
// so the only honest check that writes are live is a real billed request.
// This is the smallest one that exists: 1 output token, recorded in the same
// ledger as the run so probe spend counts against the same envelope.
//
//   PROBE_KEY=write-probe-<date> npm run -w @novagait/evals-runner matrix:probe

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";
import { EMPTY_USAGE, SpendLedger } from "./ledger";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const LEDGER_PATH = join(REPO, "evals/results/spend-ledger-2026-08-11.json");
const PROBE_MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5";

test("write-liveness probe", async () => {
  const key = process.env.PROBE_KEY;
  // No generated default: an idempotency key derived from the clock would let
  // a probe be re-billed silently on every invocation.
  if (key === undefined || key === "") throw new Error("PROBE_KEY is required");
  const ledger = await SpendLedger.open(LEDGER_PATH);
  const client = new Anthropic();

  const response = await client.messages.create({
    model: PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  });

  const usage = response.usage as unknown as Record<string, number>;
  const recorded = await ledger.add({
    key,
    lane: "write-probe",
    model: PROBE_MODEL,
    channel: "interactive",
    write_ttl: null,
    case_id: null,
    round: null,
    usage: {
      ...EMPTY_USAGE,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    },
  });
  console.log(
    `writes LIVE: ${response.id} in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cost $${recorded.toFixed(6)}; ledger $${ledger.spentUsd.toFixed(4)}`,
  );
  expect(response.id).toMatch(/^msg_/);
});
