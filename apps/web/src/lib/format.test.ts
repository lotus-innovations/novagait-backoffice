import { describe, expect, it } from "vitest";
import { INVOICE_DATE_SENTINEL } from "@novagait/pipeline";
import { formatInstant, isUnreadableDate } from "./format";

describe("formatInstant", () => {
  it("renders an ISO-UTC instant to the minute in UTC", () => {
    expect(formatInstant("2026-08-25T20:52:20.254Z")).toBe(
      "2026-08-25 20:52 UTC",
    );
  });

  it("keeps UTC regardless of the offset in the input", () => {
    expect(formatInstant("2026-08-25T22:52:20+02:00")).toBe(
      "2026-08-25 20:52 UTC",
    );
  });

  it("passes unparsable values through and renders empty ones as a dash", () => {
    expect(formatInstant("not-a-date")).toBe("not-a-date");
    expect(formatInstant(null)).toBe("-");
    expect(formatInstant("")).toBe("-");
  });
});

describe("isUnreadableDate", () => {
  it("recognizes the parser sentinel and nothing else", () => {
    expect(isUnreadableDate(INVOICE_DATE_SENTINEL)).toBe(true);
    expect(isUnreadableDate("2026-08-25")).toBe(false);
    expect(isUnreadableDate(null)).toBe(false);
  });
});
