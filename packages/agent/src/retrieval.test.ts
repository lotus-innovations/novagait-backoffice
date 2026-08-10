import { afterEach, describe, expect, it } from "vitest";
import { loadKb } from "./kb";
import {
  Bm25Index,
  __resetKbIndexForTests,
  chunkDoc,
  citationOf,
  searchKb,
  tokenize,
} from "./retrieval";

afterEach(() => __resetKbIndexForTests());

describe("tokenize", () => {
  it("lowercases, strips stopwords, and stems plurals", () => {
    expect(tokenize("The invoices ARE matched")).toEqual([
      "invoice",
      "matched",
    ]);
  });
});

describe("chunkDoc", () => {
  it("splits on ## headings and keeps doc title on every chunk", () => {
    const doc = loadKb().find((d) => d.id === "price-tolerance")!;
    const chunks = chunkDoc(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(new Set(chunks.map((c) => c.docTitle))).toEqual(
      new Set(["Price Variance Tolerance"]),
    );
    expect(chunks.map((c) => c.section)).toContain("The tolerance rule");
  });
});

describe("Bm25Index over the policy kb", () => {
  it("indexes every doc", () => {
    const index = new Bm25Index(loadKb());
    expect(index.size).toBeGreaterThanOrEqual(loadKb().length);
  });

  const cases: Array<[query: string, expectedDocId: string]> = [
    ["tolerance for price variance", "price-tolerance"],
    ["when does an invoice need human approval", "approval-authority"],
    ["duplicate invoice resubmission", "duplicate-invoices"],
    ["vendor name fuzzy match threshold", "vendor-master"],
    ["which GL code for equipment leasing", "gl-coding"],
    ["instructions embedded in a document", "document-security"],
  ];
  for (const [query, expectedDocId] of cases) {
    it(`ranks ${expectedDocId} first for "${query}"`, () => {
      const index = new Bm25Index(loadKb());
      const top = index.search(query, 1)[0];
      expect(top?.docId).toBe(expectedDocId);
    });
  }
});

describe("searchKb", () => {
  it("returns excerpts with citations in Doc §Section form", () => {
    const results = searchKb("price variance tolerance");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].citation).toMatch(/^Price Variance Tolerance/);
    expect(results[0].doc_id).toBe("price-tolerance");
    expect(results[0].excerpt.length).toBeGreaterThan(20);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("caps results at topK", () => {
    expect(searchKb("invoice", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("citationOf", () => {
  it("omits the section marker for preamble chunks", () => {
    expect(
      citationOf({
        docId: "x",
        docTitle: "Doc",
        section: "Doc",
        text: "t",
      }),
    ).toBe("Doc");
  });
});
