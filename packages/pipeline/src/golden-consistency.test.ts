// Standing consistency gate for the golden dataset (LOT-95): every golden
// case's fixture must parse to the expected fields via the deterministic
// reference parser, so goldens and fixtures cannot drift apart silently.
// Schema validation itself lives in evals/runner (golden.test.ts); this
// file guards parse-level agreement from the parser owner's side.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDORS } from "@novagait/mock-backend";
import { parseFixture } from "./parse";

const ROOT = join(__dirname, "..", "..", "..");
const GOLDEN_DIR = join(ROOT, "evals", "golden");
const FIXTURES_DIR = join(ROOT, "packages", "mock-backend", "fixtures");

interface GoldenShape {
  id: string;
  tags: string[];
  input: { fixture: string };
  expected: {
    decision: string;
    guardrail: string | null;
    fields: {
      vendor_id: string | null;
      invoice_number: string | null;
      total_cents: number | null;
      currency: string | null;
      po_reference: string | null;
    };
  };
}

async function loadCases(): Promise<GoldenShape[]> {
  const files = (await readdir(GOLDEN_DIR)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files
      .sort()
      .map(async (f) =>
        JSON.parse(await readFile(join(GOLDEN_DIR, f), "utf8")),
      ),
  );
}

// Cases whose expected values are derivable by a human (and the model path)
// but not by the deterministic parser; both predate LOT-95. Anything new
// added here needs a matching note in evals/CASE-PLAN.md.
const PARSER_BLIND: Record<string, string[]> = {
  "INV-004": ["total_cents"],
  "INV-014": ["vendor_id"],
};

describe("golden dataset consistency", () => {
  it("meets the 73-case floor with a >=20% held-out split", async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(73);
    const held = cases.filter((c) => c.tags.includes("held-out"));
    expect(held.length / cases.length).toBeGreaterThanOrEqual(0.2);
  });

  it("every fixture parses consistently with its golden expectations", async () => {
    const cases = await loadCases();
    const failures: string[] = [];
    for (const goldenCase of cases) {
      if (goldenCase.expected.decision === "reject") continue; // not invoice-shaped
      const blind = PARSER_BLIND[goldenCase.id] ?? [];
      const text = await readFile(
        join(FIXTURES_DIR, goldenCase.input.fixture),
        "utf8",
      );
      const parsed = parseFixture(text, VENDORS);
      const expected = goldenCase.expected.fields;
      // The parser has no null for some fields; map its sentinels so a null
      // expectation asserts "the parser finds nothing" instead of skipping —
      // otherwise later over-extraction (e.g. a ref line matched as an
      // invoice number on INV-037) would slip through unseen.
      const NULL_SENTINELS: Record<string, unknown> = {
        invoice_number: "UNKNOWN",
        total_cents: 0,
      };
      const check = (field: string, want: unknown, got: unknown) => {
        if (blind.includes(field)) return;
        if (want === null) {
          const nothing = got === null || got === NULL_SENTINELS[field];
          if (!nothing) {
            failures.push(
              `${goldenCase.id} ${field}: expected nothing extractable, parser got ${got}`,
            );
          }
          return;
        }
        if (got !== want) {
          failures.push(`${goldenCase.id} ${field}: want ${want}, got ${got}`);
        }
      };
      check("vendor_id", expected.vendor_id, parsed.vendor_id);
      check("total_cents", expected.total_cents, parsed.total_cents);
      check("po_reference", expected.po_reference, parsed.po_reference);
      check("currency", expected.currency, parsed.currency);
      check("invoice_number", expected.invoice_number, parsed.invoice_number);
      // Unknown-vendor cases must actually be unresolvable by the fuzzy
      // matcher, not just labeled that way.
      if (
        expected.vendor_id === null &&
        goldenCase.expected.guardrail === "GR-VENDOR" &&
        parsed.vendor_id !== null
      ) {
        failures.push(
          `${goldenCase.id}: unknown-vendor case resolved to ${parsed.vendor_id}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
