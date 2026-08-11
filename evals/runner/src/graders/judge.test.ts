import { PRICING } from "@novagait/agent";
import { describe, expect, it, vi } from "vitest";
import { loadCase, perfectOutcome } from "../test-fixtures";
import {
  GENERATOR_MODEL,
  JUDGE_MODEL,
  JUDGE_OUTPUT_SCHEMA,
  PUBLISHED_JUDGE_MODEL,
  buildJudgeRequest,
  judgeDraftedAction,
  validateJudgeVerdict,
  type JudgeClient,
  type JudgeVerdict,
} from "./judge";

const VERDICT: JudgeVerdict = {
  score: 0.82,
  verdict: "pass",
  rationale: "Summary names the route and the policy line.",
  evidence_quotes: [],
};

function fakeClient(response: unknown): JudgeClient {
  return { evaluate: vi.fn(async () => response) };
}

describe("judge model constants", () => {
  it("uses a different model for the judge than the generator", () => {
    expect(GENERATOR_MODEL).toBe("claude-haiku-4-5");
    expect(JUDGE_MODEL).toBe("claude-sonnet-5");
    expect(PUBLISHED_JUDGE_MODEL).toBe("claude-opus-5");
    expect(JUDGE_MODEL).not.toBe(GENERATOR_MODEL);
  });

  it("only names models the cost table can price", () => {
    const priced = PRICING.map((entry) => entry.model);
    for (const model of [GENERATOR_MODEL, JUDGE_MODEL, PUBLISHED_JUDGE_MODEL]) {
      expect(priced).toContain(model);
    }
  });
});

describe("judge request", () => {
  it("carries the drafted text and the expected decision, and nothing else", async () => {
    const goldenCase = await loadCase("INV-001");
    const request = buildJudgeRequest(goldenCase, "Drafted auto_approve.");
    expect(Object.keys(request).sort()).toEqual([
      "case_id",
      "drafted_action_text",
      "expected_decision",
      "instructions",
      "model",
      "output_schema",
    ]);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(
      String(goldenCase.expected.fields.invoice_number),
    );
    expect(serialized).not.toContain("lookup_vendor");
  });

  it("publishes a structured output schema with the four required keys", () => {
    expect(JUDGE_OUTPUT_SCHEMA.required).toEqual([
      "score",
      "verdict",
      "rationale",
      "evidence_quotes",
    ]);
  });
});

describe("validateJudgeVerdict", () => {
  it("accepts a well-formed verdict", () => {
    expect(validateJudgeVerdict(VERDICT).valid).toBe(true);
  });

  it("rejects out-of-range scores, bad enums, and missing fields", () => {
    expect(
      validateJudgeVerdict({ ...VERDICT, score: 1.4 }).errors[0],
    ).toContain("0..1");
    expect(validateJudgeVerdict({ ...VERDICT, verdict: "great" }).valid).toBe(
      false,
    );
    expect(validateJudgeVerdict({ ...VERDICT, rationale: " " }).valid).toBe(
      false,
    );
    expect(
      validateJudgeVerdict({ ...VERDICT, evidence_quotes: [1] }).valid,
    ).toBe(false);
    expect(validateJudgeVerdict("nope").valid).toBe(false);
  });
});

describe("judgeDraftedAction", () => {
  it("calls the injected client once with the request and returns the verdict", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase);
    const client = fakeClient({
      ...VERDICT,
      evidence_quotes: [outcome.drafted_action_text ?? ""],
    });

    const result = await judgeDraftedAction(goldenCase, outcome, { client });
    expect(result.verdict?.score).toBe(0.82);
    expect(result.errors).toEqual([]);
    expect(client.evaluate).toHaveBeenCalledTimes(1);
  });

  it("skips the judge when the run drafted nothing", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase, { drafted_action_text: null });
    const client = fakeClient(VERDICT);

    const result = await judgeDraftedAction(goldenCase, outcome, { client });
    expect(result.verdict).toBeNull();
    expect(result.skipped_reason).toContain("no drafted action");
    expect(client.evaluate).not.toHaveBeenCalled();
  });

  it("reports a malformed response instead of throwing", async () => {
    const goldenCase = await loadCase("INV-001");
    const result = await judgeDraftedAction(
      goldenCase,
      perfectOutcome(goldenCase),
      {
        client: fakeClient({ score: "high" }),
      },
    );
    expect(result.verdict).toBeNull();
    expect(result.skipped_reason).toContain("schema validation");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports a client error instead of throwing", async () => {
    const goldenCase = await loadCase("INV-001");
    const result = await judgeDraftedAction(
      goldenCase,
      perfectOutcome(goldenCase),
      {
        client: {
          evaluate: async () => {
            throw new Error("no key configured");
          },
        },
      },
    );
    expect(result.skipped_reason).toBe("judge client error");
    expect(result.errors[0]).toContain("no key configured");
  });

  it("flags evidence quotes the drafted text does not contain", async () => {
    const goldenCase = await loadCase("INV-001");
    const result = await judgeDraftedAction(
      goldenCase,
      perfectOutcome(goldenCase),
      {
        client: fakeClient({ ...VERDICT, evidence_quotes: ["never written"] }),
      },
    );
    expect(result.verdict).not.toBeNull();
    expect(result.errors[0]).toContain("not found in drafted action");
  });
});
