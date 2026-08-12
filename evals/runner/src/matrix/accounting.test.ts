import { describe, expect, it } from "vitest";
import {
  cacheStatsByLane,
  reconcileSpend,
  renderCacheSection,
} from "./accounting";
import type { LedgerEntry, LedgerFile } from "./ledger";

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  key: "batch_x:INV-001",
  lane: "claude-haiku-4-5:cached",
  model: "claude-haiku-4-5",
  channel: "batch",
  write_ttl: "1h",
  case_id: "INV-001",
  round: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  cost_usd: 0.01,
  recorded_at: "2026-08-12T00:00:00.000Z",
  ...over,
});

const ledgerOf = (entries: LedgerEntry[]): LedgerFile => ({
  version: 1,
  ticket: "LOT-105",
  envelope_hard_usd: 65,
  envelope_soft_usd: 55,
  pricing_verified_on: "2026-08-11",
  totals: {
    cost_usd: entries.reduce((a, e) => a + e.cost_usd, 0),
    by_lane: {},
    by_model: {},
    by_channel: {},
    entries: entries.length,
  },
  entries,
});

const usage = (write: number, read: number) => ({
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

describe("cacheStatsByLane", () => {
  it("reports a lane where the cache held", () => {
    const stats = cacheStatsByLane(
      ledgerOf([
        entry({ key: "b0:INV-001", round: 0, usage: usage(5000, 0) }),
        entry({ key: "b1:INV-001", round: 1, usage: usage(0, 5000) }),
        entry({ key: "b2:INV-001", round: 2, usage: usage(0, 5000) }),
      ]),
    );
    const lane = stats[0];
    expect(lane.cache_inverted).toBe(false);
    expect(lane.rounds_without_cache_benefit).toBe(0);
    expect(lane.rounds.map((r) => r.reads_dominate)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("reports a lane where the TTL expired and caching inverted", () => {
    // Every round re-writes: the entry never survived to the next round.
    const stats = cacheStatsByLane(
      ledgerOf([
        entry({ key: "b0:INV-001", round: 0, usage: usage(5000, 0) }),
        entry({ key: "b1:INV-001", round: 1, usage: usage(5000, 0) }),
        entry({ key: "b2:INV-001", round: 2, usage: usage(5000, 0) }),
      ]),
    );
    const lane = stats[0];
    expect(lane.cache_inverted).toBe(true);
    // Round 0 is excluded: the first round always writes.
    expect(lane.rounds_without_cache_benefit).toBe(2);
    expect(renderCacheSection(stats)).toMatch(/caching INVERTED/);
  });

  it("excludes judge batches, which are not a matrix lane", () => {
    const stats = cacheStatsByLane(
      ledgerOf([
        entry({ key: "b0:INV-001", lane: "judge:published", round: null }),
      ]),
    );
    expect(stats).toHaveLength(0);
  });
});

describe("reconcileSpend", () => {
  it("splits published from superseded and reconciles to the total", () => {
    const ledger = ledgerOf([
      entry({ key: "kept:INV-001", cost_usd: 1 }),
      entry({ key: "abandoned:INV-001", cost_usd: 2 }),
      entry({
        key: "latency:claude-haiku-4-5:INV-001:0",
        channel: "interactive",
        cost_usd: 0.5,
      }),
      entry({ key: "msgbatch_old:reconciled", cost_usd: 0.25 }),
    ]);
    const spend = reconcileSpend(ledger, new Set(["kept"]));

    expect(spend.published_usd).toBeCloseTo(1.5, 10);
    expect(spend.superseded.map((s) => s.cost_usd).sort()).toEqual([0.25, 2]);
    expect(spend.reconciles).toBe(true);
    expect(spend.ledger_total_usd).toBeCloseTo(3.75, 10);
  });

  it("keeps the manual reconciliation visible as its own line", () => {
    const spend = reconcileSpend(
      ledgerOf([entry({ key: "msgbatch_x:reconciled", cost_usd: 0.01 })]),
      new Set(),
    );
    expect(spend.superseded[0].label).toBe("manual reconciliation");
    expect(spend.superseded[0].reason).toMatch(/re-fetched/);
  });
});
