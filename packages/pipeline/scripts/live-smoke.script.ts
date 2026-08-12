// LOT-120 ledgered live smoke. Three real runs on claude-haiku-4-5 against
// seeded inbox items, verifying post-conditions in the trace and the stores.
// Hard abort if a single run exceeds $0.10 (ABORT_MICRO_USD).
//
// SPENDS REAL MONEY. Not reachable from CI: the root vitest config includes
// *.test.ts only, so this file runs only when it is asked for by name, with
// a key sourced into the environment:
//
//   set -a && . <secrets>/backoffice-runtime.env && set +a
//   npx vitest run --config packages/pipeline/scripts/smoke.config.ts
//
// The per-run ledger is written to SMOKE_LEDGER (default /tmp/...json)
// rather than stdout: vitest 4 swallows console output through a pipe, and
// losing the cost record of a run that has already been paid for means
// paying for it again.
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  InMemoryStore,
  VendorProfileStore,
  budgetKey,
  getApprovalForRun,
  readTrace,
  type TraceEvent,
} from "@novagait/agent";
import { MockBackend } from "@novagait/mock-backend";
import { expect, it } from "vitest";
import { runLivePipeline } from "../src/live-agent";

// Honest containment for this script, in the order the limits actually bind:
//
//  1. The PRODUCT breaker (MAX_RUN_COST_MICRO_USD, $0.03) is what stops a
//     single expensive run, and it stops it by ending the run `cost_capped`.
//     A per-run threshold above it could therefore never fire first - the old
//     $0.10 check was dead code dressed as a safety limit. So the per-run
//     rule here is: if the breaker fired, the smoke stops.
//  2. LANE_ABORT_MICRO_USD bounds the whole script, which the product knows
//     nothing about.
//
// Both set `aborted`, which every subsequent case checks BEFORE spending:
// throwing inside one `it` does not stop the ones after it.
const LANE_ABORT_MICRO_USD = 150_000; // $0.15 for the whole smoke
let aborted: string | null = null;
let spent = 0;
const MODEL = "claude-haiku-4-5";
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(5)}`;

interface Row {
  label: string;
  item: string;
  outcome: string;
  route: string | null;
  iterations: number;
  micro: number;
  tools: string;
  guardrails: string;
}
const rows: Row[] = [];

async function live(label: string, item: string) {
  if (aborted) throw new Error(`smoke aborted before ${item}: ${aborted}`);
  const store = new InMemoryStore();
  const backend = new MockBackend(store);
  await backend.seed();
  const result = await runLivePipeline({
    client: new Anthropic(),
    store,
    backend,
    inboxItemId: item,
    mode: "autonomous",
    model: MODEL,
  });
  const trace = await readTrace(store, result.runId);
  const tools = trace
    .filter(
      (e): e is Extract<TraceEvent, { type: "tool.call" }> =>
        e.type === "tool.call",
    )
    .map((e) => e.name);
  const guardrails = trace
    .filter(
      (e): e is Extract<TraceEvent, { type: "guardrail.check" }> =>
        e.type === "guardrail.check",
    )
    .filter((e) => e.verdict === "block")
    .map((e) => e.rule_id);
  rows.push({
    label,
    item,
    outcome: result.outcome,
    route: result.route,
    iterations: result.iterations,
    micro: result.totalCostMicroUsd,
    tools: tools.join(" > "),
    guardrails: guardrails.join(",") || "-",
  });
  spent += result.totalCostMicroUsd;
  if (result.outcome === "cost_capped") {
    aborted = `${item} hit the per-run cost breaker at ${usd(result.totalCostMicroUsd)}`;
  } else if (spent > LANE_ABORT_MICRO_USD) {
    aborted = `cumulative spend ${usd(spent)} exceeded the lane cap`;
  }
  if (aborted) throw new Error(`ABORT: ${aborted}`);
  return { result, store, backend, trace, tools, guardrails };
}

it("has a key without printing it", () => {
  expect(process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-")).toBe(true);
});

it("1/3 auto-approve: INB-001 executes through the gate", async () => {
  const { result, store, backend, trace } = await live(
    "auto-approve",
    "INB-001",
  );
  expect(result.outcome).toBe("executed");
  expect(result.route).toBe("auto_approve");
  const ledger = (await backend.ledgerEntries()).filter(
    (e) => e.run_id === result.runId,
  );
  expect(ledger).toHaveLength(1);
  const payment = (await backend.paymentSchedule()).find(
    (p) => p.run_id === result.runId,
  );
  expect(payment?.gl_code).toBe("6100");
  expect((await backend.getInboxItem("INB-001"))?.state).toBe("processed");
  const profile = await new VendorProfileStore(store).get("V-001");
  expect(profile?.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(
    trace.filter((e) => e.type === "model.response").length,
  ).toBeGreaterThan(0);
  expect(trace.filter((e) => e.type === "backend.write").length).toBe(2);
  expect(Number(await store.get(budgetKey()))).toBe(result.totalCostMicroUsd);
});

it("2/3 approval park: INB-013 parks above the hard floor", async () => {
  const { result, store, backend, guardrails } = await live(
    "approval-park",
    "INB-013",
  );
  expect(result.outcome).toBe("awaiting_approval");
  expect(result.route).toBe("route_for_approval");
  expect(guardrails).toContain("GR-FLOOR");
  const approval = await getApprovalForRun(store, result.runId);
  expect(approval?.status).toBe("pending");
  expect(
    (await backend.ledgerEntries()).filter((e) => e.run_id === result.runId),
  ).toEqual([]);
});

it("3/3 guardrail: INB-011 remit redirect is held", async () => {
  const { result, store, backend, guardrails } = await live(
    "guardrail-inject",
    "INB-011",
  );
  expect(result.outcome).toBe("held");
  expect(result.route).toBe("exception_hold");
  expect(guardrails).toContain("GR-INJECT");
  expect(
    (await backend.ledgerEntries()).filter((e) => e.run_id === result.runId),
  ).toEqual([]);
  expect((await backend.getInboxItem("INB-011"))?.state).toBe("held");
  const profile = await new VendorProfileStore(store).get("V-002");
  expect(profile?.exception_count).toBeGreaterThan(0);
});

it("writes the spend ledger", () => {
  const total = rows.reduce((sum, r) => sum + r.micro, 0);
  const path = process.env.SMOKE_LEDGER ?? "/tmp/lot120-live-smoke.json";
  const table = [
    "| case | item | terminal state | route | iters | cost |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.item} | ${r.outcome} | ${r.route} | ${r.iterations} | ${usd(r.micro)} |`,
    ),
    "",
    ...rows.map(
      (r) => `${r.item} tools: ${r.tools} | blocked: ${r.guardrails}`,
    ),
    "",
    `TOTAL: ${usd(total)} across ${rows.length} runs on ${MODEL}`,
  ].join("\n");
  writeFileSync(
    path,
    JSON.stringify(
      { model: MODEL, rows, total_micro_usd: total, table },
      null,
      2,
    ),
  );
  console.log(table);
  expect(rows).toHaveLength(3);
});
