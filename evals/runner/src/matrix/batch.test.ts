// Driver proof against a fake transport: the round-based loop, the iteration
// cap, transport failures and ledger idempotency all have to be right before
// this touches money, and none of them need the network to test.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GoldenCase } from "../golden";
import type { RunOutcome } from "../outcome";
import { runLane, type BatchClient, type BatchResultRow } from "./batch";
import { SpendLedger } from "./ledger";
import type { LivePipeline, LiveSession } from "./types";

const goldenCase = (id: string): GoldenCase =>
  ({
    id,
    tags: ["p0"],
    difficulty: "easy",
    input: { fixture: `inbox/${id}.md` },
    expected: {
      fields: {},
      decision: "auto_approve",
      tool_calls: [],
      must_not_call: [],
      guardrail: null,
    },
    notes: "",
  }) as unknown as GoldenCase;

function message(
  blocks: unknown[],
  stopReason: string,
): Record<string, unknown> {
  return {
    id: "msg_1",
    content: blocks,
    stop_reason: stopReason,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

const toolUse = (name: string, input: unknown) => ({
  type: "tool_use",
  id: `toolu_${name}`,
  name,
  input,
});

/** Scripts one message per (case, round); anything unscripted ends the turn. */
function fakeClient(
  script: Record<string, Record<number, unknown>>,
  spy: { batches: string[]; requestCounts: number[] },
): BatchClient {
  let submissions = -1;
  let round = -1;
  const idsByBatch = new Map<string, string[]>();
  const roundByBatch = new Map<string, number>();
  const seenThisRound = new Set<string>();
  return {
    async create(requests) {
      // A round may arrive as several chunks; a case appearing again means a
      // new round started.
      const first = requests[0]?.custom_id ?? "";
      if (seenThisRound.has(first) || seenThisRound.size === 0) {
        round += 1;
        seenThisRound.clear();
      }
      for (const request of requests) seenThisRound.add(request.custom_id);
      submissions += 1;
      const id = `batch_${submissions}`;
      idsByBatch.set(
        id,
        requests.map((request) => request.custom_id),
      );
      roundByBatch.set(id, round);
      spy.batches.push(id);
      spy.requestCounts.push(requests.length);
      return { id };
    },
    async retrieve() {
      return { processing_status: "ended" };
    },
    async cancel() {},
    async *results(batchId): AsyncIterable<BatchResultRow> {
      const index = roundByBatch.get(batchId) ?? 0;
      for (const customId of idsByBatch.get(batchId) ?? []) {
        const scripted = script[customId]?.[index];
        yield {
          custom_id: customId,
          result: scripted
            ? ({
                type: "succeeded",
                message: scripted,
              } as unknown as BatchResultRow["result"])
            : ({
                type: "succeeded",
                message: message([{ type: "text", text: "done" }], "end_turn"),
              } as unknown as BatchResultRow["result"]),
        };
      }
    },
  };
}

function fakePipeline(
  calls: string[],
  options: {
    shortCircuit?: Set<string>;
    lifecycle?: string[];
    iterations?: number[];
  } = {},
): LivePipeline {
  const shortCircuit = options.shortCircuit ?? new Set<string>();
  const lifecycle = options.lifecycle ?? [];
  const iterations = options.iterations ?? [];
  return {
    async openCase(entry) {
      const session: LiveSession = {
        runId: `RUN-${entry.id}`,
        store: {} as LiveSession["store"],
        backend: {} as LiveSession["backend"],
        userMessage: `process ${entry.id}`,
        shortCircuit: shortCircuit.has(entry.id),
        setIteration(next: number) {
          iterations.push(next);
        },
        async start() {
          lifecycle.push(`start:${entry.id}`);
        },
        async finish(args) {
          lifecycle.push(
            `finish:${entry.id}:${args.terminal?.outcome ?? "disposition"}`,
          );
        },
        executors: new Proxy(
          {},
          {
            get: (_target, name: string) => async (input: unknown) => {
              calls.push(`${entry.id}:${name}`);
              return JSON.stringify({ ok: true, input });
            },
          },
        ) as LiveSession["executors"],
        async toOutcome(): Promise<RunOutcome> {
          return {
            case_id: entry.id,
            run_id: `RUN-${entry.id}`,
            model: "claude-haiku-4-5",
            mode: "autonomous",
            fields: {} as RunOutcome["fields"],
            decision: "auto_approve",
            tool_calls: calls
              .filter((call) => call.startsWith(`${entry.id}:`))
              .map((call) => call.split(":")[1]),
            guardrails_fired: [],
            drafted_action_text: "drafted",
            output_schema_valid: true,
            schema_errors: [],
            terminal_state: "executed",
            failure_code: null,
            error_events: [],
          };
        },
      };
      return session;
    },
  };
}

async function tempLedger(): Promise<SpendLedger> {
  const dir = await mkdtemp(join(tmpdir(), "lot105-batch-"));
  return SpendLedger.open(
    join(dir, "ledger.json"),
    () => "2026-08-11T00:00:00.000Z",
  );
}

const lane = { model: "claude-haiku-4-5", mode: "cached" } as const;

describe("runLane", () => {
  it("drives tool rounds until the model stops asking", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const calls: string[] = [];
    const client = fakeClient(
      {
        "INV-001": {
          0: message([toolUse("lookup_vendor", { name_raw: "x" })], "tool_use"),
          1: message(
            [toolUse("kb_search", { query: "tolerance" })],
            "tool_use",
          ),
          2: message([{ type: "text", text: "finished" }], "end_turn"),
        },
      },
      spy,
    );

    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline(calls),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });

    expect(calls).toEqual(["INV-001:lookup_vendor", "INV-001:kb_search"]);
    expect(spy.batches).toEqual(["batch_0", "batch_1", "batch_2"]);
    expect(result.records[0].iterations).toBe(3);
    expect(result.records[0].iteration_capped).toBe(false);
    expect(result.outcomes).toHaveLength(1);
  });

  it("turns a schema-invalid tool input into an is_error result, not a call", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const calls: string[] = [];
    // draft_action carries the full extraction; {route} alone fails the schema.
    const client = fakeClient(
      {
        "INV-001": {
          0: message(
            [toolUse("draft_action", { route: "auto_approve" })],
            "tool_use",
          ),
          1: message([{ type: "text", text: "recovered" }], "end_turn"),
        },
      },
      spy,
    );

    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline(calls),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });

    expect(calls).toEqual([]);
    // The run continues so the model can recover, exactly as rawDriver does.
    expect(result.records[0].iterations).toBe(2);
    expect(result.records[0].transport_error).toBeNull();
  });

  it("never sends a request for a short-circuited case", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const lifecycle: string[] = [];
    const client = fakeClient({}, spy);

    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001"), goldenCase("INV-015")],
      pipeline: fakePipeline([], {
        shortCircuit: new Set(["INV-015"]),
        lifecycle,
      }),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });

    // Only the non-short-circuited case is ever batched.
    expect(spy.requestCounts).toEqual([1]);
    const shorted = result.records.find((r) => r.case_id === "INV-015");
    expect(shorted?.short_circuit).toBe(true);
    expect(shorted?.iterations).toBe(0);
    expect(shorted?.cost_usd).toBe(0);
    // Both still produce a graded outcome: the reject is a real result.
    expect(result.outcomes).toHaveLength(2);
  });

  it("starts every session and finishes with the driver's terminal state", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const lifecycle: string[] = [];
    const iterations: number[] = [];
    const always: Record<number, unknown> = {};
    for (let i = 0; i < 5; i++) {
      always[i] = message([toolUse("kb_search", { query: "x" })], "tool_use");
    }

    await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([], { lifecycle, iterations }),
      client: fakeClient({ "INV-001": always }, spy),
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      maxRounds: 2,
      sleep: async () => {},
    });

    expect(lifecycle[0]).toBe("start:INV-001");
    // Capped by the driver, so the breaker state is recorded rather than the
    // business disposition being settled.
    expect(lifecycle).toContain("finish:INV-001:iteration_capped");
    // Node ids follow the round that produced the call.
    expect(iterations).toEqual([0, 1]);
  });

  it("finishes a completed run through the disposition, not a terminal override", async () => {
    const lifecycle: string[] = [];
    await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([], { lifecycle }),
      client: fakeClient({}, { batches: [], requestCounts: [] }),
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });
    expect(lifecycle).toContain("finish:INV-001:disposition");
  });

  it("splits a round into chunks and processes every chunk's results", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const calls: string[] = [];
    const cases = Array.from({ length: 5 }, (_, i) =>
      goldenCase(`INV-${String(i + 1).padStart(3, "0")}`),
    );
    const script: Record<string, Record<number, unknown>> = {};
    for (const entry of cases) {
      script[entry.id] = {
        0: message([toolUse("kb_search", { query: "x" })], "tool_use"),
      };
    }

    const result = await runLane({
      lane,
      cases,
      pipeline: fakePipeline(calls),
      client: fakeClient(script, spy),
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      chunkSize: 2,
      maxRounds: 2,
      sleep: async () => {},
    });

    // Round 0: 5 cases in chunks of 2 => 3 batches. Every case must still be
    // driven and finished, not just the ones in the last chunk.
    expect(spy.requestCounts.slice(0, 3)).toEqual([2, 2, 1]);
    expect(calls.filter((c) => c.endsWith(":kb_search"))).toHaveLength(5);
    expect(result.records).toHaveLength(5);
    expect(result.records.every((r) => r.iterations === 2)).toBe(true);
  });

  it("cancels and resubmits a batch that never ends", async () => {
    // Guards the rare-event backstop: a batch that stays in_progress well
    // past any observed completion time, while identical work resubmitted
    // later is scheduled normally. Deliberately NOT keyed on request_counts:
    // those stay at zero until a batch ends, and an earlier version of this
    // check used them and cancelled healthy batches mid-flight.
    const created: string[] = [];
    const cancelled: string[] = [];
    let attempt = 0;
    const client: BatchClient = {
      async create() {
        attempt += 1;
        const id = `batch_attempt_${attempt}`;
        created.push(id);
        return { id };
      },
      async cancel(batchId) {
        cancelled.push(batchId);
      },
      async retrieve(batchId) {
        // The first submission never ends; the resubmission does. Counts are
        // deliberately omitted: they are not a usable progress signal, since
        // a real batch reports zero until the moment it finishes.
        return batchId === "batch_attempt_1"
          ? { processing_status: "in_progress" }
          : { processing_status: "ended" };
      },
      async *results() {
        yield {
          custom_id: "INV-001",
          result: {
            type: "succeeded",
            message: message([{ type: "text", text: "done" }], "end_turn"),
          },
        } as unknown as BatchResultRow;
      },
    };

    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([]),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      stallTimeoutMs: 1,
      pollIntervalMs: 1,
      sleep: async () => {},
    });

    expect(created).toEqual(["batch_attempt_1", "batch_attempt_2"]);
    expect(cancelled).toEqual(["batch_attempt_1"]);
    // The run continues on the resubmitted batch rather than failing.
    expect(result.records[0].transport_error).toBeNull();
    expect(result.records[0].iterations).toBe(1);
  });

  it("gives up after the retry budget rather than looping forever", async () => {
    let created = 0;
    const client: BatchClient = {
      async create() {
        created += 1;
        return { id: `stuck_${created}` };
      },
      async cancel() {},
      async retrieve() {
        return { processing_status: "in_progress" };
      },
      async *results() {},
    };

    await expect(
      runLane({
        lane,
        cases: [goldenCase("INV-001")],
        pipeline: fakePipeline([]),
        client,
        ledger: await tempLedger(),
        worstCasePerCaseUsd: 0.001,
        stallTimeoutMs: 1,
        pollIntervalMs: 1,
        stallRetries: 2,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/no progress after 3 attempts/);
    expect(created).toBe(3);
  });

  it("only resubmits cases that are still running", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const client = fakeClient(
      {
        "INV-001": {
          0: message([toolUse("lookup_vendor", {})], "tool_use"),
          1: message([{ type: "text", text: "done" }], "end_turn"),
        },
        // INV-002 ends on the first round and must drop out of round 1.
      },
      spy,
    );

    await runLane({
      lane,
      cases: [goldenCase("INV-001"), goldenCase("INV-002")],
      pipeline: fakePipeline([]),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });

    expect(spy.requestCounts).toEqual([2, 1]);
  });

  it("caps iterations instead of looping forever", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const always: Record<number, unknown> = {};
    for (let i = 0; i < 20; i++) {
      always[i] = message([toolUse("kb_search", { query: "x" })], "tool_use");
    }
    const client = fakeClient({ "INV-001": always }, spy);

    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([]),
      client,
      ledger: await tempLedger(),
      worstCasePerCaseUsd: 0.001,
      maxRounds: 3,
      sleep: async () => {},
    });

    expect(result.rounds).toBe(3);
    expect(result.records[0].iteration_capped).toBe(true);
  });

  it("ends a case on a failed batch result rather than retrying it", async () => {
    const client: BatchClient = {
      async cancel() {},
      async create() {
        return { id: "batch_0" };
      },
      async retrieve() {
        return { processing_status: "ended" };
      },
      async *results() {
        yield {
          custom_id: "INV-001",
          result: { type: "errored", error: { message: "overloaded" } },
        } as unknown as BatchResultRow;
      },
    };

    const ledger = await tempLedger();
    const result = await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([]),
      client,
      ledger,
      worstCasePerCaseUsd: 0.001,
      sleep: async () => {},
    });

    expect(result.records[0].transport_error).toBe("overloaded");
    expect(ledger.spentUsd).toBe(0);
  });

  it("refuses to submit when the worst case would cross the envelope", async () => {
    const ledger = await tempLedger();
    await expect(
      runLane({
        lane,
        cases: [goldenCase("INV-001")],
        pipeline: fakePipeline([]),
        client: fakeClient({}, { batches: [], requestCounts: [] }),
        ledger,
        worstCasePerCaseUsd: 1_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/hard stop/);
    expect(ledger.spentUsd).toBe(0);
  });

  it("records one ledger entry per result, keyed so re-reads are free", async () => {
    const spy = { batches: [] as string[], requestCounts: [] as number[] };
    const client = fakeClient(
      { "INV-001": { 0: message([toolUse("kb_search", {})], "tool_use") } },
      spy,
    );
    const ledger = await tempLedger();
    await runLane({
      lane,
      cases: [goldenCase("INV-001")],
      pipeline: fakePipeline([]),
      client,
      ledger,
      worstCasePerCaseUsd: 0.001,
      maxRounds: 2,
      sleep: async () => {},
    });

    expect(ledger.totals.entries).toBe(2);
    expect(ledger.has("batch_0:INV-001")).toBe(true);
    const before = ledger.spentUsd;
    await ledger.add({
      key: "batch_0:INV-001",
      lane: "claude-haiku-4-5:cached",
      model: "claude-haiku-4-5",
      channel: "batch",
      write_ttl: "1h",
      case_id: "INV-001",
      round: 0,
      usage: {
        input_tokens: 9_999_999,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(ledger.spentUsd).toBe(before);
  });
});
