import { describe, expect, it } from "vitest";
import {
  isOrderedSubsequence,
  normalizeCurrency,
  normalizeDate,
  normalizeToken,
} from "./normalize";

describe("normalizeToken", () => {
  it("trims, collapses whitespace, and upper-cases", () => {
    expect(normalizeToken("  po-2201 ")).toBe("PO-2201");
    expect(normalizeToken("CB  2026\t0803")).toBe("CB 2026 0803");
  });

  it("collapses empty and non-string values to null", () => {
    expect(normalizeToken("")).toBeNull();
    expect(normalizeToken("   ")).toBeNull();
    expect(normalizeToken(null)).toBeNull();
    expect(normalizeToken(undefined)).toBeNull();
  });
});

describe("normalizeCurrency", () => {
  it("parses symbols, names, and codes to ISO codes", () => {
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(normalizeCurrency("US Dollars")).toBe("USD");
    expect(normalizeCurrency("eur")).toBe("EUR");
    expect(normalizeCurrency("cad")).toBe("CAD");
  });

  it("rejects values that are not resolvable currencies", () => {
    expect(normalizeCurrency("dollarsish")).toBeNull();
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("accepts equivalent forms of the same date", () => {
    for (const form of [
      "2026-03-11",
      "2026/03/11",
      "03/11/2026",
      "3.11.2026",
      "11 Mar 2026",
      "March 11, 2026",
      "Mar. 11 2026",
    ]) {
      expect(normalizeDate(form)).toBe("2026-03-11");
    }
  });

  it("rejects impossible and unrecognizable dates", () => {
    expect(normalizeDate("2026-02-30")).toBeNull();
    expect(normalizeDate("2026-13-01")).toBeNull();
    expect(normalizeDate("next Tuesday")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });

  it("keeps leap-year days that exist", () => {
    expect(normalizeDate("02/29/2028")).toBe("2028-02-29");
    expect(normalizeDate("02/29/2027")).toBeNull();
  });
});

describe("isOrderedSubsequence", () => {
  const expected = ["lookup_vendor", "lookup_po", "draft_action"];

  it("allows unrelated calls to interleave", () => {
    expect(
      isOrderedSubsequence(expected, [
        "lookup_vendor",
        "kb_search",
        "lookup_po",
        "check_duplicate",
        "draft_action",
      ]),
    ).toBe(true);
  });

  it("rejects out-of-order and missing calls", () => {
    expect(
      isOrderedSubsequence(expected, [
        "lookup_po",
        "lookup_vendor",
        "draft_action",
      ]),
    ).toBe(false);
    expect(
      isOrderedSubsequence(expected, ["lookup_vendor", "draft_action"]),
    ).toBe(false);
  });

  it("is vacuously true for no expectations", () => {
    expect(isOrderedSubsequence([], ["draft_action"])).toBe(true);
  });
});
