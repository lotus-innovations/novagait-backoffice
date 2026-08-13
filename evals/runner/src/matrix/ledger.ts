// Actual-spend ledger for the LOT-105 live matrix (spec 13 §3).
//
// This is the containment control for the run, so two properties matter more
// than convenience:
//
//   1. Cost is computed from MEASURED usage fields returned by the API, never
//      from the estimate. The estimate bounds a submission; this records what
//      it actually cost.
//   2. Every entry carries an idempotency key. Batch results are streamed and
//      may be re-read (a re-poll, a resumed lane, a retry after a crash); a
//      re-read must never double-count. Adding an existing key is a no-op.
//
// Why the cost math lives here and not in packages/agent: computeCostMicroUsd
// prices a single interactive run and hardcodes the 5m cache-write multiplier
// (1.25x). The matrix runs through the Batch API (50% off input AND output)
// with the 1h TTL (2.0x writes). Using the runtime function would under-report
// every cached batch write by 37.5% of that component. The multipliers below
// are the ones already verified in ../spend/cost.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BATCH_DISCOUNT,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  PRICING,
  PRICING_VERIFIED_ON,
} from "../spend/cost";

/** Abhinav-approved envelope, 2026-08-11. Hard stop, not a target. */
export const ENVELOPE_HARD_USD = 65;
/** Pause and report once crossed, after the in-flight submission settles. */
export const ENVELOPE_SOFT_USD = 55;

export type Channel = "batch" | "interactive";
export type WriteTtl = "1h" | "5m" | null;

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const EMPTY_USAGE: UsageTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * Resolves a dated snapshot id to the pricing alias.
 *
 * The driver records the alias it submitted (`claude-haiku-4-5`), but a batch
 * result's `message.model` echoes the resolved snapshot
 * (`claude-haiku-4-5-20251001`). MATRIX_SWEEP prices from that echoed field, so
 * without this the sweep throws instead of recording billed-but-unread spend -
 * exactly the entries the envelope most needs. Only an 8-digit date suffix is
 * stripped, and the stripped id must still be a known model: an unrecognised
 * model must fail loudly rather than be priced as something it is not.
 */
export function pricingAlias(model: string): string {
  const undated = model.replace(/-\d{8}$/, "");
  return undated in PRICING ? undated : model;
}

function ratesFor(model: string): { input: number; output: number } {
  const entry = PRICING[pricingAlias(model) as keyof typeof PRICING];
  if (entry === undefined) {
    throw new Error(`ledger: no pricing for model ${model}`);
  }
  return { input: entry.inputPerMTok, output: entry.outputPerMTok };
}

export interface CostInputs {
  model: string;
  usage: UsageTokens;
  channel: Channel;
  /** TTL of the cache WRITE being billed; null when nothing was written. */
  writeTtl: WriteTtl;
}

/**
 * Cost in USD for one model response.
 *
 * Cache reads bill at 0.1x input, cache writes at 2.0x (1h) or 1.25x (5m),
 * and the Batch API halves the whole bill. `usage.input_tokens` is the
 * uncached remainder only, so the three input components are additive.
 */
export function costUsd({
  model,
  usage,
  channel,
  writeTtl,
}: CostInputs): number {
  const rates = ratesFor(model);
  const writeMultiplier =
    writeTtl === "1h" ? CACHE_WRITE_1H_MULTIPLIER : CACHE_WRITE_5M_MULTIPLIER;
  const perMTok =
    usage.input_tokens * rates.input +
    usage.cache_creation_input_tokens * rates.input * writeMultiplier +
    usage.cache_read_input_tokens * rates.input * CACHE_READ_MULTIPLIER +
    usage.output_tokens * rates.output;
  const discount = channel === "batch" ? BATCH_DISCOUNT : 1;
  return (perMTok / 1_000_000) * discount;
}

export interface LedgerEntry {
  /** Idempotency key. Re-adding the same key is ignored. */
  key: string;
  lane: string;
  model: string;
  channel: Channel;
  write_ttl: WriteTtl;
  case_id: string | null;
  round: number | null;
  usage: UsageTokens;
  cost_usd: number;
  recorded_at: string;
}

export interface LedgerTotals {
  cost_usd: number;
  by_lane: Record<string, number>;
  by_model: Record<string, number>;
  by_channel: Record<string, number>;
  entries: number;
}

export interface LedgerFile {
  version: number;
  ticket: string;
  envelope_hard_usd: number;
  envelope_soft_usd: number;
  pricing_verified_on: string;
  totals: LedgerTotals;
  entries: LedgerEntry[];
}

export const LEDGER_VERSION = 1;

function emptyTotals(): LedgerTotals {
  return {
    cost_usd: 0,
    by_lane: {},
    by_model: {},
    by_channel: {},
    entries: 0,
  };
}

/**
 * Derives every total from the entries.
 *
 * Exported because anything that appends to a ledger file out of band (the
 * MATRIX_SWEEP pass) must refresh the WHOLE totals block. Updating only
 * `cost_usd` and `entries` leaves `by_lane`, `by_model` and `by_channel`
 * disagreeing with the entries they summarise, which is how a published
 * ledger ends up with per-lane figures that do not add up to its own total.
 */
export function recomputeTotals(entries: LedgerEntry[]): LedgerTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    totals.cost_usd += entry.cost_usd;
    totals.by_lane[entry.lane] =
      (totals.by_lane[entry.lane] ?? 0) + entry.cost_usd;
    totals.by_model[entry.model] =
      (totals.by_model[entry.model] ?? 0) + entry.cost_usd;
    totals.by_channel[entry.channel] =
      (totals.by_channel[entry.channel] ?? 0) + entry.cost_usd;
  }
  totals.entries = entries.length;
  return totals;
}

export class EnvelopeExceeded extends Error {
  constructor(
    readonly spentUsd: number,
    readonly worstCaseUsd: number,
    readonly submission: string,
  ) {
    super(
      `envelope: ${submission} would reach $${(spentUsd + worstCaseUsd).toFixed(2)} ` +
        `(spent $${spentUsd.toFixed(2)} + worst case $${worstCaseUsd.toFixed(2)}) ` +
        `against a $${ENVELOPE_HARD_USD} hard stop`,
    );
    this.name = "EnvelopeExceeded";
  }
}

/**
 * The run's spend record, persisted after every mutation.
 *
 * Written through on each add so a crashed lane leaves a truthful file behind:
 * an under-recorded ledger is the failure mode that matters, since it is the
 * one that lets the next submission through the hard stop.
 */
export class SpendLedger {
  private constructor(
    readonly path: string,
    private file: LedgerFile,
    private readonly keys: Set<string>,
    private readonly now: () => string,
  ) {}

  static async open(
    path: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<SpendLedger> {
    let file: LedgerFile;
    try {
      file = JSON.parse(await readFile(path, "utf8")) as LedgerFile;
    } catch {
      file = {
        version: LEDGER_VERSION,
        ticket: "LOT-105",
        envelope_hard_usd: ENVELOPE_HARD_USD,
        envelope_soft_usd: ENVELOPE_SOFT_USD,
        pricing_verified_on: PRICING_VERIFIED_ON,
        totals: emptyTotals(),
        entries: [],
      };
    }
    // Totals are derived, never trusted from disk: a hand-edited or partially
    // written file must not be able to raise the remaining envelope.
    file.totals = recomputeTotals(file.entries);
    return new SpendLedger(
      path,
      file,
      new Set(file.entries.map((entry) => entry.key)),
      now,
    );
  }

  get spentUsd(): number {
    return this.file.totals.cost_usd;
  }

  get totals(): LedgerTotals {
    return this.file.totals;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Returns the recorded cost, or 0 when the key was already present. */
  async add(
    entry: Omit<LedgerEntry, "cost_usd" | "recorded_at"> & {
      cost_usd?: number;
    },
  ): Promise<number> {
    if (this.keys.has(entry.key)) return 0;
    const cost =
      entry.cost_usd ??
      costUsd({
        model: entry.model,
        usage: entry.usage,
        channel: entry.channel,
        writeTtl: entry.write_ttl,
      });
    const recorded: LedgerEntry = {
      ...entry,
      cost_usd: cost,
      recorded_at: this.now(),
    };
    this.file.entries.push(recorded);
    this.keys.add(entry.key);
    this.file.totals = recomputeTotals(this.file.entries);
    await this.save();
    return cost;
  }

  /**
   * Pre-submission gate (spec 13 §3, orchestrator rule 3). Worst case is
   * computed by the caller from measured per-model token counts; a submission
   * that could cross the hard stop is refused rather than trimmed.
   */
  assertHeadroom(worstCaseUsd: number, submission: string): void {
    if (this.spentUsd + worstCaseUsd > ENVELOPE_HARD_USD) {
      throw new EnvelopeExceeded(this.spentUsd, worstCaseUsd, submission);
    }
  }

  /** True once the ledger alone crosses the soft line and work should pause. */
  get shouldPause(): boolean {
    return this.spentUsd >= ENVELOPE_SOFT_USD;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      `${JSON.stringify(this.file, null, 2)}\n`,
      "utf8",
    );
  }

  snapshot(): LedgerFile {
    return JSON.parse(JSON.stringify(this.file)) as LedgerFile;
  }
}
