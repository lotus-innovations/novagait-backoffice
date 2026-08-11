import { VENDOR_MATCH_THRESHOLD, jaroWinkler } from "@novagait/agent";
import { describe, expect, it } from "vitest";
import { loadCase, perfectOutcome } from "../test-fixtures";
import { gradeDeterministic } from "./deterministic";
import { gradeFuzzy } from "./fuzzy";
import type { CheckResult } from "./types";

// Hand-built catalog: the ERP seed data is another lane's file, and the
// credit rule under test is about the threshold, not about that data.
const VENDORS = [
  { id: "V-002", canonical_name: "Meridex Equipment Leasing" },
  { id: "V-009", canonical_name: "Northgate Clinical Supply" },
];

function check(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check with id ${id}`);
  return found;
}

describe("layer 2 fuzzy grader", () => {
  it("credits a vendor whose raw name resolves above the shared threshold", async () => {
    const goldenCase = await loadCase("INV-011");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.vendor_id = null;
    outcome.fields.vendor_name_raw = "Meridex Equip. Leasing";
    // The threshold is the production constant, never a literal.
    expect(
      jaroWinkler("Meridex Equip. Leasing", "Meridex Equipment Leasing"),
    ).toBeGreaterThanOrEqual(VENDOR_MATCH_THRESHOLD);

    const layer1 = gradeDeterministic(goldenCase, outcome);
    const result = check(
      gradeFuzzy(goldenCase, outcome, layer1, { vendors: VENDORS }),
      "vendor_resolution",
    );
    expect(result.status).toBe("pass");
    expect(result.credits).toEqual(["field:vendor_id"]);
  });

  it("refuses credit below the threshold without adding a second failure", async () => {
    const goldenCase = await loadCase("INV-011");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.vendor_id = null;
    outcome.fields.vendor_name_raw = "Northgate Clinical Supply";

    const layer1 = gradeDeterministic(goldenCase, outcome);
    const result = check(
      gradeFuzzy(goldenCase, outcome, layer1, { vendors: VENDORS }),
      "vendor_resolution",
    );
    expect(result.status).toBe("not_applicable");
    expect(result.code).toBeNull();
  });

  it("skips vendor credit when there is nothing to repair or nothing to repair it with", async () => {
    const goldenCase = await loadCase("INV-011");
    const clean = perfectOutcome(goldenCase);
    const cleanLayer1 = gradeDeterministic(goldenCase, clean);
    expect(
      check(
        gradeFuzzy(goldenCase, clean, cleanLayer1, { vendors: VENDORS }),
        "vendor_resolution",
      ).detail,
    ).toContain("no credit needed");

    const unresolved = perfectOutcome(goldenCase);
    unresolved.fields.vendor_id = null;
    const layer1 = gradeDeterministic(goldenCase, unresolved);
    expect(
      check(gradeFuzzy(goldenCase, unresolved, layer1, {}), "vendor_resolution")
        .detail,
    ).toContain("no vendor catalog");
  });

  it("credits an equivalent currency spelling", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.currency = "US Dollars";

    const layer1 = gradeDeterministic(goldenCase, outcome);
    const result = check(
      gradeFuzzy(goldenCase, outcome, layer1, {}),
      "currency_parse",
    );
    expect(result.status).toBe("pass");
    expect(result.credits).toEqual(["field:currency"]);
  });

  it("refuses currency credit for a different currency", async () => {
    const goldenCase = await loadCase("INV-001");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.currency = "EUR";

    const layer1 = gradeDeterministic(goldenCase, outcome);
    expect(
      check(gradeFuzzy(goldenCase, outcome, layer1, {}), "currency_parse")
        .status,
    ).toBe("not_applicable");
  });

  it("accepts equivalent date forms and fails unparseable ones", async () => {
    const goldenCase = await loadCase("INV-001");
    const ok = perfectOutcome(goldenCase);
    ok.fields.invoice_date = "August 3, 2026";
    ok.fields.due_date = "09/02/2026";
    const okResult = check(
      gradeFuzzy(goldenCase, ok, gradeDeterministic(goldenCase, ok), {}),
      "date_normalization",
    );
    expect(okResult.status).toBe("pass");
    expect(okResult.detail).toContain("2026-08-03");

    const bad = perfectOutcome(goldenCase);
    bad.fields.invoice_date = "sometime in August";
    const badResult = check(
      gradeFuzzy(goldenCase, bad, gradeDeterministic(goldenCase, bad), {}),
      "date_normalization",
    );
    expect(badResult.status).toBe("fail");
    expect(badResult.code).toBe("EXT-002");
  });

  it("skips date grading when the run recorded no dates", async () => {
    const goldenCase = await loadCase("INV-015");
    const outcome = perfectOutcome(goldenCase);
    outcome.fields.invoice_date = null;
    expect(
      check(
        gradeFuzzy(
          goldenCase,
          outcome,
          gradeDeterministic(goldenCase, outcome),
          {},
        ),
        "date_normalization",
      ).status,
    ).toBe("not_applicable");
  });
});
