// Shakedown gate (LOT-90): every golden case must be schema-valid, point at
// a real fixture, and the set must cover every failure family from
// spec 09 §1. This test IS the dataset lint; it grows with the set.

import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECISIONS,
  loadGoldenCases,
  validateGoldenCase,
  type GoldenCase,
} from "./golden";

const GOLDEN_DIR = fileURLToPath(new URL("../../golden", import.meta.url));
const FIXTURES_DIR = fileURLToPath(
  new URL("../../../packages/mock-backend/fixtures", import.meta.url),
);

const REQUIRED_FAMILIES = [
  "happy-path",
  "tolerance-edge",
  "missing-field",
  "ambiguous",
  "unknown-vendor",
  "closed-po",
  "price-mismatch",
  "qty-mismatch",
  "duplicate",
  "injection",
  "injection-benign",
  "hard-floor",
  "non-usd",
  "out-of-scope",
];

async function cases(): Promise<GoldenCase[]> {
  return loadGoldenCases(GOLDEN_DIR);
}

describe("golden dataset (shakedown set)", () => {
  it("loads at least 15 schema-valid cases with unique ids", async () => {
    const all = await cases();
    expect(all.length).toBeGreaterThanOrEqual(15);
    const ids = new Set(all.map((goldenCase) => goldenCase.id));
    expect(ids.size).toBe(all.length);
  });

  it("every referenced fixture file exists", async () => {
    for (const goldenCase of await cases()) {
      await expect(
        access(join(FIXTURES_DIR, goldenCase.input.fixture)),
      ).resolves.toBeUndefined();
    }
  });

  it("covers every required failure family at least once", async () => {
    const tags = new Set(
      (await cases()).flatMap((goldenCase) => goldenCase.tags),
    );
    for (const family of REQUIRED_FAMILIES) {
      expect(tags, `missing family: ${family}`).toContain(family);
    }
  });

  it("covers every decision route at least once", async () => {
    const decisions = new Set(
      (await cases()).map((goldenCase) => goldenCase.expected.decision),
    );
    for (const decision of DECISIONS) {
      expect(decisions, `missing decision: ${decision}`).toContain(decision);
    }
  });

  it("has P0 coverage on guardrails, duplicate, hard-floor, and happy path", async () => {
    const p0 = (await cases()).filter((goldenCase) =>
      goldenCase.tags.includes("p0"),
    );
    expect(p0.length).toBeGreaterThanOrEqual(5);
    const p0Tags = new Set(p0.flatMap((goldenCase) => goldenCase.tags));
    for (const tag of ["happy-path", "duplicate", "injection", "hard-floor"]) {
      expect(p0Tags, `p0 must include a ${tag} case`).toContain(tag);
    }
  });

  it("guardrail expectations are consistent with decisions", async () => {
    for (const goldenCase of await cases()) {
      const { decision, guardrail, must_not_call } = goldenCase.expected;
      if (guardrail === "GR-SCOPE") expect(decision).toBe("reject");
      if (guardrail === "GR-DUP" || guardrail === "GR-VENDOR") {
        expect(decision).toBe("exception_hold");
      }
      if (decision !== "auto_approve") {
        expect(
          must_not_call,
          `${goldenCase.id}: non-auto decisions must forbid execute_action`,
        ).toContain("execute_action");
      }
    }
  });

  it("rejects a malformed case (validator bites)", () => {
    const result = validateGoldenCase({
      id: "INV-999",
      tags: [],
      difficulty: "impossible",
      input: {},
      expected: {
        fields: { vendor_id: null },
        decision: "maybe",
        tool_calls: ["telepathy"],
        must_not_call: [],
        guardrail: "sometimes",
      },
      notes: "x",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });
});
