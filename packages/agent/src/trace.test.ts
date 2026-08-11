import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCostMicroUsd, pricingFor } from "./pricing";
import { digestText, redactToolArgs } from "./redact";
import { InMemoryStore } from "./store";
import { TRACE_SCHEMA_VERSION, validateTraceEvent } from "./trace";
import {
  RECENT_RUNS_CAP,
  TraceWriter,
  readTrace,
  toJsonl,
  traceKeys,
} from "./trace-writer";
import { ulid } from "./ulid";

describe("ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it("sorts lexicographically by creation time", () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(1_000_000_100_000);
    expect(earlier < later).toBe(true);
  });
});

describe("pricing", () => {
  it("computes integer micro-USD from all four usage counters", () => {
    // haiku: in $1/MTok, out $5/MTok, cache write 1.25x, cache read 0.1x
    // 1000*1 + 4096*1*1.25 + 10000*1*0.1 + 500*5 = 1000+5120+1000+2500
    const cost = computeCostMicroUsd("claude-haiku-4-5", {
      input_tokens: 1000,
      cache_creation_input_tokens: 4096,
      cache_read_input_tokens: 10000,
      output_tokens: 500,
    });
    expect(cost).toBe(9620);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("throws on a model with no pricing entry", () => {
    expect(() => pricingFor("claude-nonexistent")).toThrow(/No pricing entry/);
  });

  it("carries provenance fields on every entry", () => {
    const entry = pricingFor("claude-sonnet-5");
    expect(entry.verifiedOn).toBe("2026-08-10");
    expect(entry.source).toBeTruthy();
  });
});

describe("redaction", () => {
  it("digests text with length and marker, no raw content", () => {
    const digested = digestText("wire funds to Acme Holdings, Zurich");
    expect(digested.redacted).toBe(true);
    expect(digested.length).toBe(35);
    expect(digested.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(digested)).not.toContain("Zurich");
  });

  it("redacts designated fields, including nested, and leaves the rest", () => {
    const redacted = redactToolArgs({
      vendor_id: "V-001",
      amount_cents: 42800,
      remit_to: "Corvida Billing Partners, Los Angeles",
      draft: { note_text: "internal hold note", route: "exception_hold" },
    });
    expect(redacted.vendor_id).toBe("V-001");
    expect(redacted.amount_cents).toBe(42800);
    expect((redacted.remit_to as { redacted: boolean }).redacted).toBe(true);
    const draft = redacted.draft as Record<string, unknown>;
    expect((draft.note_text as { redacted: boolean }).redacted).toBe(true);
    expect(draft.route).toBe("exception_hold");
    expect(JSON.stringify(redacted)).not.toContain("Corvida");
  });
});

describe("validateTraceEvent", () => {
  const base = {
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    node_id: "ingest",
    ts: "2026-08-10T12:00:00.000-07:00",
    seq: 0,
    trace_schema_version: TRACE_SCHEMA_VERSION,
  };

  it("accepts a complete run.start", () => {
    const result = validateTraceEvent({
      ...base,
      type: "run.start",
      mode: "assisted",
      input_ref: "inbox/2026-03-11-corvida.md",
      prompt_version: "p1",
      tools_version: "t1",
      model: "claude-haiku-4-5",
      sdk_version: "0.115.0",
    });
    expect(result.valid).toBe(true);
  });

  it("names every missing required field", () => {
    const result = validateTraceEvent({ ...base, type: "run.start" });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("mode");
    expect(result.errors.join(" ")).toContain("sdk_version");
  });

  it("rejects unknown event types", () => {
    const result = validateTraceEvent({ ...base, type: "run.mystery" });
    expect(result.valid).toBe(false);
  });
});

describe("TraceWriter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function writeLifecycle(store: InMemoryStore) {
    const writer = new TraceWriter(store);
    await writer.append({
      type: "run.start",
      node_id: "run",
      mode: "assisted",
      input_ref: "inbox/fixture.md",
      prompt_version: "p1",
      tools_version: "t1",
      model: "claude-haiku-4-5",
      sdk_version: "0.115.0",
    });
    await writer.append({
      type: "tool.call",
      node_id: "agent.iter[0].tool[draft_action]",
      name: "draft_action",
      args: { remit_to: "Corvida Billing Partners", vendor_id: "V-001" },
      result_summary: "draft created",
      duration_ms: 12,
      attempt: 1,
    });
    await writer.append({
      type: "model.response",
      node_id: "agent.iter[0].model",
      model: "claude-haiku-4-5",
      stop_reason: "tool_use",
      input_tokens: 900,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_micro_usd: 1900,
      latency_ms: 640,
    });
    await writer.append({
      type: "run.end",
      node_id: "run",
      outcome: "executed",
      total_cost_micro_usd: 1900,
      input_tokens: 900,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iteration_count: 1,
      failure_code: null,
    });
    return writer;
  }

  it("stamps monotonic seq, version, and run_id on every event", async () => {
    const store = new InMemoryStore();
    const writer = await writeLifecycle(store);
    const events = await readTrace(store, writer.runId);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    for (const event of events) {
      expect(event.run_id).toBe(writer.runId);
      expect(event.trace_schema_version).toBe(TRACE_SCHEMA_VERSION);
      expect(event.ts).toBeTruthy();
    }
  });

  it("redacts tool args at the write boundary", async () => {
    const store = new InMemoryStore();
    const writer = await writeLifecycle(store);
    const raw = await store.listRange(traceKeys.trace(writer.runId), 0, -1);
    expect(raw.join("")).not.toContain("Corvida");
    const events = await readTrace(store, writer.runId);
    const toolCall = events.find((event) => event.type === "tool.call");
    expect(toolCall && "args" in toolCall && toolCall.args.vendor_id).toBe(
      "V-001",
    );
  });

  it("maintains the run summary hash and recent index", async () => {
    const store = new InMemoryStore();
    const writer = await writeLifecycle(store);
    const summary = await store.hgetall(traceKeys.run(writer.runId));
    expect(summary?.outcome).toBe("executed");
    expect(summary?.total_cost_micro_usd).toBe("1900");
    expect(summary?.started_at).toBeTruthy();
    expect(summary?.ended_at).toBeTruthy();
    const recent = await store.listRange(traceKeys.recent(), 0, -1);
    expect(recent).toContain(writer.runId);
  });

  it("caps the recent-runs index", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < RECENT_RUNS_CAP + 5; i++) {
      const writer = new TraceWriter(store);
      await writer.append({
        type: "run.start",
        node_id: "run",
        mode: "shadow",
        input_ref: `inbox/${i}.md`,
        prompt_version: "p1",
        tools_version: "t1",
        model: "claude-haiku-4-5",
        sdk_version: "0.115.0",
      });
    }
    const recent = await store.listRange(traceKeys.recent(), 0, -1);
    expect(recent).toHaveLength(RECENT_RUNS_CAP);
  });

  it("rejects events with missing required fields", async () => {
    const store = new InMemoryStore();
    const writer = new TraceWriter(store);
    await expect(
      // deliberately malformed: run.start without its payload
      writer.append({ type: "run.start", node_id: "run" } as never),
    ).rejects.toThrow(/invalid trace event/);
  });

  it("exports parseable jsonl", async () => {
    const store = new InMemoryStore();
    const writer = await writeLifecycle(store);
    const events = await readTrace(store, writer.runId);
    const lines = toJsonl(events).trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(validateTraceEvent(JSON.parse(line)).valid).toBe(true);
    }
  });
});

describe("InMemoryStore TTL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires keys after the TTL", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    await store.set("k", "v", 60);
    expect(await store.get("k")).toBe("v");
    vi.advanceTimersByTime(61_000);
    expect(await store.get("k")).toBeNull();
  });
});
