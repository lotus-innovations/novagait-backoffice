import { describe, expect, it } from "vitest";
import {
  DOCUMENTED_KNOWN_FAILING,
  UNDOCUMENTED_KNOWN_FAILING,
  buildBaseline,
  expectedFailingCaseIds,
} from "./baseline";
import { failingCaseIds, loadBaseline, replay } from "./replay";

describe("replay baseline", () => {
  it("declares exactly the cases that actually fail", async () => {
    const { summary } = await replay();
    expect(failingCaseIds(summary)).toEqual(expectedFailingCaseIds());
  });

  it("carries CASE-PLAN deviation 7's model-path-only cases verbatim", () => {
    expect(DOCUMENTED_KNOWN_FAILING).toEqual([
      "INV-004",
      "INV-014",
      "INV-021",
      "INV-022",
      "INV-023",
      "INV-035",
      "INV-041",
      "INV-052",
    ]);
  });

  it("keeps the documented and undocumented buckets disjoint", () => {
    const documented = new Set(DOCUMENTED_KNOWN_FAILING);
    const undocumented = Object.values(UNDOCUMENTED_KNOWN_FAILING).flat();
    expect(undocumented.filter((id) => documented.has(id))).toEqual([]);
    expect(undocumented.every((id) => /^INV-\d{3}$/.test(id))).toBe(true);
  });

  it("every declared failing case is really failing, and every failure is declared", async () => {
    const { summary } = await replay();
    const failing = new Set(failingCaseIds(summary));
    const passing = expectedFailingCaseIds().filter((id) => !failing.has(id));
    expect(passing, "declared-failing cases that now pass").toEqual([]);
    const undeclared = [...failing].filter(
      (id) => !expectedFailingCaseIds().includes(id),
    );
    expect(undeclared, "failures missing from the baseline header").toEqual([]);
  });

  it("the committed file is what buildBaseline produces from the graded summary", async () => {
    const { summary } = await replay();
    const committed = await loadBaseline();
    expect(committed).toEqual(buildBaseline(summary));
  });

  it("the guardrail-family gate is not silently green", async () => {
    const committed = await loadBaseline();
    // The only GRD failures left in this lane are INV-041/052: the parser
    // is blind to their field-level defects (CASE-PLAN deviation 7), so the
    // mock lane routes them auto_approve and executes what the goldens
    // forbid. A change in this count is a real signal, not noise.
    expect(committed.summary.guardrail_failures).toBe(2);
    expect(committed.summary.failures_by_code["GRD-004"]).toBe(2);
  });
});
