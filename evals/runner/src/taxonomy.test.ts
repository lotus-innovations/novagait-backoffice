import { describe, expect, it } from "vitest";
import {
  FAMILY_PRECEDENCE,
  TAXONOMY,
  assertKnownCode,
  familyOf,
  familyRank,
  rankCodes,
  taxonomyCode,
} from "./taxonomy";

// Arch doc B freezes six families and their code lists; taxonomy.json is the
// copy the report page renders, so drift here is a published-number bug.
const EXPECTED_CODES: Record<string, number> = {
  EXT: 4,
  DEC: 3,
  TOOL: 4,
  GRD: 4,
  FMT: 2,
  SYS: 3,
};

describe("taxonomy.json", () => {
  it("carries exactly the six families from arch doc B", () => {
    const prefixes = TAXONOMY.families.map((family) => family.prefix);
    expect(prefixes.sort()).toEqual(Object.keys(EXPECTED_CODES).sort());
  });

  it("carries the documented code count per family", () => {
    for (const family of TAXONOMY.families) {
      expect(family.codes).toHaveLength(EXPECTED_CODES[family.prefix]);
    }
  });

  it("gives every code a label and a definition", () => {
    for (const family of TAXONOMY.families) {
      for (const code of family.codes) {
        expect(code.code).toMatch(/^(EXT|DEC|TOOL|GRD|FMT|SYS)-\d{3}$/);
        expect(code.label.length).toBeGreaterThan(3);
        expect(code.definition.length).toBeGreaterThan(20);
      }
    }
  });

  it("declares a precedence covering every family, with a rationale", () => {
    expect([...FAMILY_PRECEDENCE].sort()).toEqual(
      Object.keys(EXPECTED_CODES).sort(),
    );
    expect(TAXONOMY.precedence_rationale.length).toBeGreaterThan(80);
  });
});

describe("code helpers", () => {
  it("resolves known codes and rejects unknown ones", () => {
    expect(taxonomyCode("GRD-001")?.label).toBe("injection followed");
    expect(taxonomyCode("GRD-999")).toBeUndefined();
    expect(assertKnownCode("EXT-002")).toBe("EXT-002");
    expect(() => assertKnownCode("EXT-999")).toThrow(/unknown taxonomy code/);
  });

  it("reads the family from the code prefix", () => {
    expect(familyOf("TOOL-004")).toBe("TOOL");
    expect(familyRank("SYS-001")).toBeLessThan(familyRank("GRD-001"));
    expect(familyRank("GRD-001")).toBeLessThan(familyRank("DEC-001"));
  });

  it("ranks by family precedence, dedupes, and breaks ties by input order", () => {
    expect(rankCodes(["DEC-001", "EXT-002", "GRD-003", "SYS-002"])).toEqual([
      "SYS-002",
      "GRD-003",
      "EXT-002",
      "DEC-001",
    ]);
    expect(rankCodes(["EXT-001", "EXT-002", "EXT-001"])).toEqual([
      "EXT-001",
      "EXT-002",
    ]);
  });
});
