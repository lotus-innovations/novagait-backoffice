// Both drivers run against a real Anthropic client whose fetch is scripted,
// so the full request/parse path executes with zero key and zero network.

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCachedSystem,
  resolveThinking,
  runWorkflow,
  selectDriver,
  type DriverName,
} from "./loop";
import { CACHE_TTL_BATCH, CACHE_TTL_INTERACTIVE } from "./policy-constants";
import { InMemoryStore } from "./store";
import { readTrace } from "./trace-writer";
import { TOOL_NAMES, type ToolExecutors } from "./tools";

function apiMessage(overrides: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 900,
      output_tokens: 120,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

const TOOL_USE_RESPONSE = apiMessage({
  content: [
    {
      type: "tool_use",
      id: "toolu_1",
      name: "lookup_vendor",
      input: { name_raw: "Corvida Billing Partners" },
    },
  ],
  stop_reason: "tool_use",
});

const FINAL_RESPONSE = apiMessage({
  content: [{ type: "text", text: "Drafted for approval." }],
  usage: {
    input_tokens: 1100,
    output_tokens: 80,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
});

function scriptedClient(
  responses: object[],
  sent?: Array<Record<string, unknown>>,
): Anthropic {
  let index = 0;
  return new Anthropic({
    apiKey: "test-key-never-real",
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      if (sent && typeof init?.body === "string") {
        sent.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      const body = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

function stubExecutors(calls: Array<{ name: string; input: unknown }>) {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      async (input: unknown) => {
        calls.push({ name, input });
        return JSON.stringify({ ok: true, tool: name });
      },
    ]),
  ) as unknown as ToolExecutors;
}

async function run(driver: DriverName, responses: object[], extra = {}) {
  const store = new InMemoryStore();
  const calls: Array<{ name: string; input: unknown }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const result = await runWorkflow({
    client: scriptedClient(responses, sent),
    store,
    mode: "assisted",
    inputRef: "inbox/2026-08-03-corvida-monthly.md",
    userMessage: "Process this invoice.",
    executors: stubExecutors(calls),
    driver,
    resolveOutcome: () => ({
      outcome: "awaiting_approval",
      failure_code: null,
    }),
    ...extra,
  });
  const events = await readTrace(store, result.runId);
  return { result, events, calls, sent };
}

type SystemBlock = { type: string; text: string; cache_control?: unknown };

describe.each<DriverName>(["raw", "runner"])("%s driver", (driver) => {
  it("runs the tool loop and emits the full trace", async () => {
    const { result, events, calls } = await run(driver, [
      TOOL_USE_RESPONSE,
      FINAL_RESPONSE,
    ]);
    expect(result.driver).toBe(driver);
    expect(result.iterations).toBe(2);
    expect(result.finalText).toBe("Drafted for approval.");
    expect(result.outcome).toBe("awaiting_approval");
    expect(calls).toEqual([
      {
        name: "lookup_vendor",
        input: { name_raw: "Corvida Billing Partners" },
      },
    ]);
    expect(result.totals.input_tokens).toBe(2000);
    expect(result.totals.output_tokens).toBe(200);
    // haiku: 2000*1 + 200*5 = 3000 micro-USD
    expect(result.totalCostMicroUsd).toBe(3000);

    const kinds = events.map((event) => event.type);
    expect(kinds).toEqual([
      "run.start",
      "model.request",
      "model.response",
      "tool.call",
      "model.request",
      "model.response",
      "run.end",
    ]);
  });
});

describe("driver parity", () => {
  it("both drivers produce identical event sequences and totals", async () => {
    const raw = await run("raw", [TOOL_USE_RESPONSE, FINAL_RESPONSE]);
    const runner = await run("runner", [TOOL_USE_RESPONSE, FINAL_RESPONSE]);
    expect(raw.events.map((event) => event.type)).toEqual(
      runner.events.map((event) => event.type),
    );
    expect(raw.result.totalCostMicroUsd).toBe(runner.result.totalCostMicroUsd);
    expect(raw.result.finalText).toBe(runner.result.finalText);
    expect(raw.result.outcome).toBe(runner.result.outcome);
  });
});

describe("breakers", () => {
  it("caps iterations with SYS-003 when the model never stops calling tools", async () => {
    const { result, events } = await run(
      "raw",
      [TOOL_USE_RESPONSE, TOOL_USE_RESPONSE, TOOL_USE_RESPONSE],
      { maxIterations: 2 },
    );
    expect(result.outcome).toBe("iteration_capped");
    expect(result.failureCode).toBe("SYS-003");
    expect(result.iterations).toBe(2);
    const end = events.at(-1);
    expect(end?.type).toBe("run.end");
    expect(end && "outcome" in end && end.outcome).toBe("iteration_capped");
  });

  it("caps cost with SYS-003 when spend exceeds the per-run ceiling", async () => {
    const expensive = apiMessage({
      content: [{ type: "text", text: "big" }],
      usage: {
        input_tokens: 50_000,
        output_tokens: 10_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const { result } = await run("raw", [expensive]);
    // 50000*1 + 10000*5 = 100000 micro-USD, over any configured cap
    expect(result.outcome).toBe("cost_capped");
    expect(result.failureCode).toBe("SYS-003");
  });

  it("records SYS-002 error outcome when the API fails", async () => {
    const client = new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const store = new InMemoryStore();
    const result = await runWorkflow({
      client,
      store,
      mode: "shadow",
      inputRef: "inbox/x.md",
      userMessage: "hi",
      executors: stubExecutors([]),
      driver: "raw",
    });
    expect(result.outcome).toBe("error");
    expect(result.failureCode).toBe("SYS-002");
    const events = await readTrace(store, result.runId);
    expect(events.at(-1)?.type).toBe("run.end");
  });
});

describe("selectDriver", () => {
  const original = process.env.AGENT_LOOP;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_LOOP;
    else process.env.AGENT_LOOP = original;
  });

  it("defaults to runner, honors AGENT_LOOP=raw, and explicit args win", () => {
    delete process.env.AGENT_LOOP;
    expect(selectDriver()).toBe("runner");
    process.env.AGENT_LOOP = "raw";
    expect(selectDriver()).toBe("raw");
    expect(selectDriver("runner")).toBe("runner");
    process.env.AGENT_LOOP = "nonsense";
    expect(selectDriver()).toBe("runner");
  });
});

// LOT-119. Both drivers must mark the SAME system+tools prefix, or the two
// drivers write two cache entries for one prompt and the eval matrix pays
// the write premium twice.
describe.each<DriverName>(["raw", "runner"])("%s driver caching", (driver) => {
  it("marks the last system block with a 5m breakpoint by default", async () => {
    const { sent } = await run(driver, [TOOL_USE_RESPONSE, FINAL_RESPONSE]);
    expect(sent.length).toBeGreaterThan(0);
    for (const body of sent) {
      const system = body.system as SystemBlock[];
      expect(Array.isArray(system)).toBe(true);
      expect(system.at(-1)?.cache_control).toEqual({
        type: "ephemeral",
        ttl: CACHE_TTL_INTERACTIVE,
      });
    }
  });

  it("uses the 1h TTL when the batch/eval lane asks for it", async () => {
    const { sent } = await run(driver, [FINAL_RESPONSE], {
      cacheTtl: CACHE_TTL_BATCH,
    });
    const system = sent[0].system as SystemBlock[];
    expect(system.at(-1)?.cache_control).toEqual({
      type: "ephemeral",
      ttl: CACHE_TTL_BATCH,
    });
  });

  it("keeps the marked prefix byte-identical across iterations", async () => {
    const { sent } = await run(driver, [TOOL_USE_RESPONSE, FINAL_RESPONSE]);
    const rendered = sent.map((body) => JSON.stringify(body.system));
    expect(new Set(rendered).size).toBe(1);
  });

  it("drops thinking:disabled on the production haiku model", async () => {
    const { sent } = await run(driver, [FINAL_RESPONSE], {
      thinking: { type: "disabled" },
    });
    // DEFAULT_MODEL is claude-haiku-4-5: the param must never reach the wire.
    expect(sent[0].thinking).toBeUndefined();
  });

  it("sends thinking:disabled on a matrix model that accepts it", async () => {
    const { sent } = await run(driver, [FINAL_RESPONSE], {
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
    });
    expect(sent[0].thinking).toEqual({ type: "disabled" });
  });
});

describe("cache + thinking helpers", () => {
  it("puts exactly one breakpoint, on the last block", () => {
    const blocks = buildCachedSystem("prompt text", CACHE_TTL_BATCH);
    expect(blocks).toHaveLength(1);
    expect(blocks.at(-1)?.cache_control).toEqual({
      type: "ephemeral",
      ttl: CACHE_TTL_BATCH,
    });
    expect(blocks.filter((b) => b.cache_control).length).toBe(1);
  });

  it("allowlists thinking:disabled rather than denylisting", () => {
    const disabled = { type: "disabled" } as const;
    expect(resolveThinking("claude-sonnet-5", disabled)).toEqual(disabled);
    expect(resolveThinking("claude-opus-5", disabled)).toEqual(disabled);
    expect(resolveThinking("claude-haiku-4-5", disabled)).toBeUndefined();
    // An unknown model gets the param dropped, never forwarded on faith.
    expect(resolveThinking("some-future-model", disabled)).toBeUndefined();
  });

  it("passes non-disabled thinking through untouched", () => {
    const adaptive = { type: "adaptive" } as const;
    expect(resolveThinking("claude-haiku-4-5", adaptive)).toEqual(adaptive);
    expect(resolveThinking("claude-haiku-4-5", undefined)).toBeUndefined();
  });
});
