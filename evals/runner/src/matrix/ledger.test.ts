import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_HARD_USD,
  EnvelopeExceeded,
  SpendLedger,
  costUsd,
  type LedgerFile,
} from "./ledger";

const usage = (over: Partial<Record<string, number>> = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...over,
});

async function tempLedger(): Promise<SpendLedger> {
  const dir = await mkdtemp(join(tmpdir(), "lot105-ledger-"));
  let tick = 0;
  return SpendLedger.open(
    join(dir, "spend-ledger.json"),
    () => `2026-08-11T00:00:0${tick++}.000Z`,
  );
}

describe("costUsd", () => {
  it("halves both input and output on the batch channel", () => {
    const args = {
      model: "claude-haiku-4-5",
      usage: usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }),
      writeTtl: null,
    } as const;
    const interactive = costUsd({ ...args, channel: "interactive" });
    const batch = costUsd({ ...args, channel: "batch" });
    expect(interactive).toBeCloseTo(1.0 + 5.0, 10);
    expect(batch).toBeCloseTo(interactive / 2, 10);
  });

  it("prices a 1h cache write at 2x input, not the 1.25x the runtime uses", () => {
    const base = {
      model: "claude-haiku-4-5",
      usage: usage({ cache_creation_input_tokens: 1_000_000 }),
      channel: "interactive",
    } as const;
    expect(costUsd({ ...base, writeTtl: "1h" })).toBeCloseTo(2.0, 10);
    expect(costUsd({ ...base, writeTtl: "5m" })).toBeCloseTo(1.25, 10);
    // The gap this guards is the whole reason the ledger does its own math:
    // computeCostMicroUsd would report the 5m figure for a 1h batch write.
    expect(costUsd({ ...base, writeTtl: "1h" })).toBeGreaterThan(
      costUsd({ ...base, writeTtl: "5m" }),
    );
  });

  it("prices a cache read at a tenth of input", () => {
    expect(
      costUsd({
        model: "claude-opus-5",
        usage: usage({ cache_read_input_tokens: 1_000_000 }),
        channel: "interactive",
        writeTtl: "1h",
      }),
    ).toBeCloseTo(0.5, 10);
  });

  it("refuses a model it cannot price", () => {
    expect(() =>
      costUsd({
        model: "claude-not-real",
        usage: usage({ input_tokens: 10 }),
        channel: "batch",
        writeTtl: null,
      }),
    ).toThrow(/no pricing/);
  });
});

describe("SpendLedger", () => {
  const entry = (key: string) => ({
    key,
    lane: "claude-haiku-4-5:cached",
    model: "claude-haiku-4-5",
    channel: "batch" as const,
    write_ttl: "1h" as const,
    case_id: "INV-001",
    round: 0,
    usage: usage({ input_tokens: 1_000_000 }),
  });

  it("ignores a repeated key so a re-poll cannot double-count", async () => {
    const ledger = await tempLedger();
    const first = await ledger.add(entry("batch_1:INV-001"));
    const second = await ledger.add(entry("batch_1:INV-001"));
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(ledger.totals.entries).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(0.5, 10);
  });

  it("recomputes totals from entries rather than trusting the file", async () => {
    const ledger = await tempLedger();
    await ledger.add(entry("batch_1:INV-001"));

    const tampered = JSON.parse(
      await readFile(ledger.path, "utf8"),
    ) as LedgerFile;
    tampered.totals.cost_usd = 0;
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(ledger.path, JSON.stringify(tampered), "utf8"),
    );

    const reopened = await SpendLedger.open(ledger.path);
    expect(reopened.spentUsd).toBeCloseTo(0.5, 10);
  });

  it("blocks a submission that could cross the hard stop", async () => {
    const ledger = await tempLedger();
    expect(() => ledger.assertHeadroom(ENVELOPE_HARD_USD + 1, "lane")).toThrow(
      EnvelopeExceeded,
    );
    expect(() => ledger.assertHeadroom(1, "lane")).not.toThrow();
  });

  it("flags the soft pause once spend crosses it", async () => {
    const ledger = await tempLedger();
    expect(ledger.shouldPause).toBe(false);
    await ledger.add({
      ...entry("big"),
      usage: usage({ input_tokens: 120_000_000 }),
    });
    expect(ledger.spentUsd).toBeGreaterThan(55);
    expect(ledger.shouldPause).toBe(true);
  });

  it("survives a reopen and keeps totals additive", async () => {
    const ledger = await tempLedger();
    await ledger.add(entry("batch_1:INV-001"));
    const reopened = await SpendLedger.open(ledger.path);
    await reopened.add(entry("batch_2:INV-002"));
    expect(reopened.totals.entries).toBe(2);
    expect(reopened.spentUsd).toBeCloseTo(1.0, 10);
    expect(reopened.totals.by_lane["claude-haiku-4-5:cached"]).toBeCloseTo(
      1.0,
      10,
    );
  });
});
