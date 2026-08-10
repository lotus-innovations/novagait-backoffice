// Drift gates for the policy corpus: (1) the generated module must match
// kb/*.md on disk; (2) every threshold the corpus states must render from
// policy-constants, so a constant change without a kb edit fails CI (the
// "thresholds live only in policy-constants" rule, extended to prose).
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KB_FILES } from "./kb.generated";
import { __resetKbCacheForTests, loadKb } from "./kb";
import {
  AUTONOMY_CAP_CENTS,
  HARD_FLOOR_CENTS,
  PRICE_TOLERANCE_MIN_CENTS,
  PRICE_TOLERANCE_PCT,
  VENDOR_MATCH_THRESHOLD,
} from "./policy-constants";

const DIR = fileURLToPath(new URL("../kb", import.meta.url));

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);

afterEach(() => __resetKbCacheForTests());

describe("kb.generated", () => {
  it("matches kb/*.md exactly", async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".md")).sort();
    expect(Object.keys(KB_FILES).sort()).toEqual(files);
    for (const file of files) {
      expect(KB_FILES[file], file).toBe(
        await readFile(join(DIR, file), "utf8"),
      );
    }
  });
});

describe("loadKb", () => {
  it("exposes every doc with id and heading-derived title", () => {
    const docs = loadKb();
    expect(docs.length).toBe(Object.keys(KB_FILES).length);
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get("price-tolerance")?.title).toBe("Price Variance Tolerance");
    for (const doc of docs) {
      expect(doc.id).not.toMatch(/\.md$/);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.content).toContain(`# ${doc.title}`);
    }
  });
});

describe("kb thresholds stay consistent with policy-constants", () => {
  const corpus = Object.values(KB_FILES).join("\n");

  it("autonomy cap", () => {
    expect(corpus).toContain(usd(AUTONOMY_CAP_CENTS)); // "$500.00"
  });

  it("hard escalation floor", () => {
    expect(corpus).toContain(usd(HARD_FLOOR_CENTS)); // "$5,000.00"
  });

  it("price tolerance percent and minimum", () => {
    expect(corpus).toContain(`${PRICE_TOLERANCE_PCT * 100}%`); // "2%"
    expect(corpus).toContain(usd(PRICE_TOLERANCE_MIN_CENTS)); // "$25.00"
  });

  it("vendor match threshold", () => {
    expect(corpus).toContain(VENDOR_MATCH_THRESHOLD.toFixed(2)); // "0.90"
  });
});
