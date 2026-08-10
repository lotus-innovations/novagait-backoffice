import { describe, expect, it } from "vitest";
import {
  DEDUPE_TTL_SECONDS,
  DedupeLedger,
  PROFILE_VERSION,
  VendorProfileStore,
  contentDigest,
  normalizeContent,
} from "./memory";
import { InMemoryStore } from "./store";

describe("normalizeContent / contentDigest", () => {
  it("collapses whitespace so reformatting does not change the digest", () => {
    const a = "Invoice INV-1\n  Total: $100.00\n";
    const b = "Invoice   INV-1 Total: $100.00";
    expect(normalizeContent(a)).toBe("Invoice INV-1 Total: $100.00");
    expect(contentDigest(a)).toBe(contentDigest(b));
  });

  it("is 16 hex chars and content-sensitive", () => {
    expect(contentDigest("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(contentDigest("x")).not.toBe(contentDigest("y"));
  });
});

describe("DedupeLedger", () => {
  it("returns null for unseen digests and the prior run once recorded", async () => {
    const ledger = new DedupeLedger(new InMemoryStore());
    const digest = contentDigest("some invoice");
    expect(await ledger.check(digest)).toBeNull();
    await ledger.record(digest, "run-1");
    expect(await ledger.check(digest)).toBe("run-1");
  });

  it("expires entries after the TTL", async () => {
    const store = new InMemoryStore();
    const ledger = new DedupeLedger(store);
    const digest = contentDigest("some invoice");
    await ledger.record(digest, "run-1");
    // Simulate the TTL passing via the store's expiry clock.
    await store.expire(`seen:${digest}`, -1);
    expect(await ledger.check(digest)).toBeNull();
    expect(DEDUPE_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe("VendorProfileStore", () => {
  it("returns null for unknown vendors", async () => {
    const profiles = new VendorProfileStore(new InMemoryStore());
    expect(await profiles.get("V-404")).toBeNull();
  });

  it("creates a versioned profile on first update and counts runs", async () => {
    const profiles = new VendorProfileStore(new InMemoryStore());
    const first = await profiles.applyUpdate("V-001", {
      canonical_name: "Corvida Billing Partners",
      last_seen: "2026-08-10",
    });
    expect(first.profile).toEqual({
      profile_version: PROFILE_VERSION,
      canonical_name: "Corvida Billing Partners",
      last_seen: "2026-08-10",
      runs_count: 1,
      exception_count: 0,
      learned_gl_code: null,
    });
    expect(first.rejected).toEqual([]);

    const second = await profiles.applyUpdate("V-001", {
      last_seen: "2026-08-11",
      learned_gl_code: "6150",
      exception_increment: 1,
    });
    expect(second.profile.runs_count).toBe(2);
    expect(second.profile.exception_count).toBe(1);
    expect(second.profile.learned_gl_code).toBe("6150");
    expect(second.profile.canonical_name).toBe("Corvida Billing Partners");
    // The diff is exactly what the memory.write trace event carries.
    expect(second.diff).toEqual({
      runs_count: "2",
      last_seen: "2026-08-11",
      learned_gl_code: "6150",
      exception_count: "1",
    });
  });

  it("rejects out-of-schema values instead of writing them", async () => {
    const profiles = new VendorProfileStore(new InMemoryStore());
    const result = await profiles.applyUpdate("V-002", {
      canonical_name: "   ",
      last_seen: "yesterday",
      learned_gl_code: "not-a-code",
      exception_increment: -5,
    });
    expect(result.rejected.sort()).toEqual([
      "canonical_name",
      "exception_increment",
      "last_seen",
      "learned_gl_code",
    ]);
    expect(result.profile.learned_gl_code).toBeNull();
    expect(result.profile.exception_count).toBe(0);
    expect(result.profile.last_seen).toBe("");
  });

  it("caps the exception count", async () => {
    const profiles = new VendorProfileStore(new InMemoryStore());
    await profiles.applyUpdate("V-003", { exception_increment: 5000 });
    const again = await profiles.applyUpdate("V-003", {
      exception_increment: 5,
    });
    expect(again.profile.exception_count).toBe(999);
  });
});
