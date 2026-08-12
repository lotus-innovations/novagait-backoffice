import { describe, expect, it } from "vitest";
import type { GoldenCase } from "../golden";
import type { RunOutcome } from "../outcome";
import {
  CALIBRATION_SAMPLE_SIZE,
  buildCalibration,
  selectCalibrationCases,
} from "./calibration";
import { percentile, selectLatencyCases, summarizeLatency } from "./latency";

const caseOf = (id: string, tags: string[]): GoldenCase =>
  ({
    id,
    tags,
    difficulty: "easy",
    input: { fixture: `inbox/${id}.md` },
    expected: {
      fields: {},
      decision: "route_for_approval",
      tool_calls: [],
      must_not_call: [],
      guardrail: null,
    },
    notes: "",
  }) as unknown as GoldenCase;

const outcomeOf = (id: string, text: string | null): RunOutcome =>
  ({
    case_id: id,
    run_id: `RUN-${id}`,
    model: "claude-haiku-4-5",
    mode: "autonomous",
    fields: {},
    decision: "route_for_approval",
    tool_calls: [],
    guardrails_fired: [],
    drafted_action_text: text,
    output_schema_valid: true,
    schema_errors: [],
    terminal_state: "held",
    failure_code: null,
    error_events: [],
  }) as unknown as RunOutcome;

describe("selectCalibrationCases", () => {
  it("takes the lowest-numbered cases carrying both held-out and p0", () => {
    const cases = [
      caseOf("INV-050", ["held-out", "p0"]),
      caseOf("INV-002", ["held-out"]), // not p0
      caseOf("INV-010", ["p0"]), // not held-out
      caseOf("INV-030", ["held-out", "p0"]),
      caseOf("INV-005", ["held-out", "p0"]),
    ];
    expect(selectCalibrationCases(cases, 2).map((entry) => entry.id)).toEqual([
      "INV-005",
      "INV-030",
    ]);
  });

  it("defaults to 15 and is stable across repeated calls", () => {
    const cases = Array.from({ length: 40 }, (_, i) =>
      caseOf(`INV-${String(i + 1).padStart(3, "0")}`, ["held-out", "p0"]),
    );
    const first = selectCalibrationCases(cases);
    expect(first).toHaveLength(CALIBRATION_SAMPLE_SIZE);
    expect(selectCalibrationCases(cases.slice().reverse())).toEqual(first);
  });
});

describe("buildCalibration", () => {
  const cases = [
    caseOf("INV-005", ["held-out", "p0"]),
    caseOf("INV-030", ["held-out", "p0"]),
  ];

  it("blinds the worksheet: no model identity and no machine score", () => {
    const { worksheet } = buildCalibration({
      cases,
      outcomes: [
        outcomeOf("INV-005", "Holding invoice pending clarification."),
        outcomeOf("INV-030", "Routing for approval above the autonomy cap."),
      ],
      lane: "claude-haiku-4-5:cached",
      model: "claude-haiku-4-5",
      generatedOn: "2026-08-11",
      size: 2,
    });

    expect(worksheet).not.toContain("claude-haiku-4-5");
    expect(worksheet).not.toContain("claude-sonnet-5");
    // Blinding is about machine SCORES and model identity, not about hiding
    // that a judge exists: the scorer needs to know why only three criteria
    // are graded. What must never appear is a filled-in verdict or score.
    expect(worksheet).not.toMatch(/verdict:\s*(pass|borderline|fail)/i);
    expect(worksheet).not.toMatch(/score["']?\s*[:=]\s*0?\.\d/i);
    expect(worksheet).toContain("D01");
    expect(worksheet).toContain("D02");
    // Expected decision is shown because the judge sees it too; scoring on
    // different evidence would make the agreement number meaningless.
    expect(worksheet).toContain("route_for_approval");
    for (const criterion of ["tone", "completeness", "evidence", "verdict"]) {
      expect(worksheet).toContain(`- D01 ${criterion}:`);
    }
  });

  it("keeps the model mapping in the key, not the worksheet", () => {
    const { key } = buildCalibration({
      cases,
      outcomes: [outcomeOf("INV-005", "text"), outcomeOf("INV-030", "text")],
      lane: "claude-haiku-4-5:cached",
      model: "claude-haiku-4-5",
      generatedOn: "2026-08-11",
      size: 2,
    });
    expect(key.drafts[0]).toMatchObject({
      label: "D01",
      case_id: "INV-005",
      model: "claude-haiku-4-5",
    });
    expect(key.selection_rule).toMatch(/held-out/);
  });

  it("skips drafts the judge would also skip, and says so", () => {
    const { worksheet, skipped, key } = buildCalibration({
      cases,
      outcomes: [outcomeOf("INV-005", null), outcomeOf("INV-030", "text")],
      lane: "claude-haiku-4-5:cached",
      model: "claude-haiku-4-5",
      generatedOn: "2026-08-11",
      size: 2,
    });
    expect(skipped).toEqual([
      { case_id: "INV-005", reason: "run produced no drafted action text" },
    ]);
    expect(key.drafts).toHaveLength(1);
    expect(key.drafts[0].case_id).toBe("INV-030");
    expect(worksheet).toContain("Not scored");
  });
});

describe("latency statistics", () => {
  it("uses nearest-rank percentiles over observed runs", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([42], 50)).toBe(42);
  });

  it("summarizes per model", () => {
    const stats = summarizeLatency([
      { model: "a", latency_ms: 100 },
      { model: "a", latency_ms: 300 },
      { model: "b", latency_ms: 50 },
    ] as never);
    const a = stats.find((entry) => entry.model === "a");
    expect(a?.runs).toBe(2);
    expect(a?.min_ms).toBe(100);
    expect(a?.max_ms).toBe(300);
    expect(a?.mean_ms).toBe(200);
  });

  it("selects a deterministic P0 subset", () => {
    const cases = [
      caseOf("INV-009", ["p0"]),
      caseOf("INV-001", ["p0"]),
      caseOf("INV-004", ["extraction"]),
    ];
    expect(selectLatencyCases(cases, 2).map((entry) => entry.id)).toEqual([
      "INV-001",
      "INV-009",
    ]);
  });
});
