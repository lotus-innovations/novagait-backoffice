import { describe, expect, it } from "vitest";
import {
  SCORE_RANGE_NOTE,
  apiSchema,
  describeScore,
  judgeKey,
} from "./judge-batch";

// The API validates batch custom_id against ^[a-zA-Z0-9_-]{1,64}$ and rejects
// the whole submission on a violation. That cost a smoke run to discover, so
// the constraint is pinned here rather than rediscovered.
describe("judgeKey", () => {
  const PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

  it("is a legal batch custom_id for every matrix model", () => {
    for (const model of [
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
    ]) {
      expect(judgeKey("INV-001", model)).toMatch(PATTERN);
    }
  });

  it("round-trips distinctly per case and model", () => {
    expect(judgeKey("INV-001", "claude-opus-5")).not.toBe(
      judgeKey("INV-001", "claude-sonnet-5"),
    );
    expect(judgeKey("INV-002", "claude-opus-5")).not.toBe(
      judgeKey("INV-001", "claude-opus-5"),
    );
  });
});

// A batch is rejected WHOLESALE if any request carries an unsupported schema
// keyword, so this is a spend-costing constraint, not a nicety. Discovered by
// a smoke run; pinned here so it is never rediscovered the same way.
describe("apiSchema", () => {
  it("strips numerical constraints the API rejects", () => {
    const stripped = apiSchema({
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 1 },
        nested: { type: "array", items: { type: "number", multipleOf: 0.5 } },
      },
    }) as Record<string, never>;
    expect(JSON.stringify(stripped)).not.toMatch(/minimum|maximum|multipleOf/);
  });

  it("leaves everything else intact", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
      required: ["verdict"],
      additionalProperties: false,
    };
    expect(apiSchema(schema)).toEqual(schema);
  });
});

// Stripping the bound from the schema silently changes what the judge thinks
// "score" means: a live check returned 7.5 on a 0..1 field, which
// validateJudgeVerdict discards, which would empty calibration with no error.
describe("describeScore", () => {
  it("carries the range in a description the model can read", () => {
    const schema = describeScore({
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 1 } },
    }) as { properties: { score: { description?: string } } };
    expect(schema.properties.score.description).toBe(SCORE_RANGE_NOTE);
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum/);
  });

  it("states the scale explicitly enough to rule out 0-10", () => {
    expect(SCORE_RANGE_NOTE).toMatch(/0\.0 to 1\.0/);
    expect(SCORE_RANGE_NOTE).toMatch(/0-10|percentage/);
  });
});
