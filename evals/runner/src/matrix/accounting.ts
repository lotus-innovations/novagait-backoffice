// Spend and cache accounting over the ledger.
//
// Two things the published report has to be able to say without hand-waving:
//
//   1. What the cached column actually did, round by round. Caching is only a
//      saving while the 1h TTL survives the gap between rounds. At batch-round
//      cadences above that TTL every round pays a 2x write instead of a 0.1x
//      read and the cached lane costs MORE than the uncached one. That is a
//      real finding worth publishing with its numbers, not a number to quietly
//      relabel (team-lead ruling, 2026-08-12).
//
//   2. Where every dollar went, including dollars that bought nothing. A
//      cancelled run's spend is real and must reconcile against the ledger
//      without a footnote explaining a discrepancy.

import type { LedgerEntry, LedgerFile } from "./ledger";

export interface RoundCacheStats {
  lane: string;
  round: number;
  requests: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  uncached_input_tokens: number;
  cost_usd: number;
  /** False once writes outweigh reads: the TTL is no longer being caught. */
  reads_dominate: boolean;
}

export interface LaneCacheStats {
  lane: string;
  rounds: RoundCacheStats[];
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  /** Rounds where writes outweighed reads, i.e. the cache did not carry. */
  rounds_without_cache_benefit: number;
  /**
   * True when the lane paid more in cache writes than it saved on reads.
   * Publishable as-is: it means caching inverted at this cadence.
   */
  cache_inverted: boolean;
}

const isMatrixLane = (entry: LedgerEntry): boolean =>
  entry.channel === "batch" && !entry.lane.startsWith("judge:");

/**
 * Per-round cache behaviour for each lane.
 *
 * `publishedBatchIds` scopes the table to the attempt that was actually
 * PUBLISHED. Without it, a lane that ran more than once folds every attempt's
 * rounds together: `claude-opus-5:cached` was attempted three times and both
 * haiku lanes twice, so round 0 would report the sum of several attempts'
 * requests and write tokens and the cached column would misdescribe the lane
 * in the matrix. This is the same defect that `reconcileSpend` fixed for spend
 * attribution (incident 11) and it was still open for cache stats. Omitting
 * the set keeps the old whole-ledger behaviour for callers that have no
 * checkpoint to attribute from.
 */
export function cacheStatsByLane(
  ledger: LedgerFile,
  publishedBatchIds?: Set<string>,
): LaneCacheStats[] {
  const lanes = new Map<string, Map<number, RoundCacheStats>>();

  for (const entry of ledger.entries) {
    if (!isMatrixLane(entry)) continue;
    if (
      publishedBatchIds !== undefined &&
      !publishedBatchIds.has(entry.key.split(":")[0])
    ) {
      continue;
    }
    const round = entry.round ?? 0;
    const rounds = lanes.get(entry.lane) ?? new Map<number, RoundCacheStats>();
    const stats = rounds.get(round) ?? {
      lane: entry.lane,
      round,
      requests: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 0,
      cost_usd: 0,
      reads_dominate: false,
    };
    stats.requests += 1;
    stats.cache_read_tokens += entry.usage.cache_read_input_tokens;
    stats.cache_write_tokens += entry.usage.cache_creation_input_tokens;
    stats.uncached_input_tokens += entry.usage.input_tokens;
    stats.cost_usd += entry.cost_usd;
    stats.reads_dominate = stats.cache_read_tokens > stats.cache_write_tokens;
    rounds.set(round, stats);
    lanes.set(entry.lane, rounds);
  }

  return [...lanes.entries()].map(([lane, rounds]) => {
    const ordered = [...rounds.values()].sort((a, b) => a.round - b.round);
    const read = ordered.reduce((a, r) => a + r.cache_read_tokens, 0);
    const write = ordered.reduce((a, r) => a + r.cache_write_tokens, 0);
    return {
      lane,
      rounds: ordered,
      cache_read_tokens: read,
      cache_write_tokens: write,
      cost_usd: ordered.reduce((a, r) => a + r.cost_usd, 0),
      // Round 0 always writes, so it is excluded from the "did the cache
      // carry" count: what matters is whether LATER rounds caught the entry.
      rounds_without_cache_benefit: ordered.filter(
        (r) => r.round > 0 && !r.reads_dominate,
      ).length,
      cache_inverted: write > read,
    };
  });
}

export interface SpendReconciliation {
  ledger_total_usd: number;
  /** Spend attributable to lanes present in the published matrix. */
  published_usd: number;
  /** Real spend that bought nothing publishable, itemised rather than hidden. */
  superseded: { label: string; cost_usd: number; reason: string }[];
  reconciles: boolean;
}

/**
 * Splits ledger spend into what the published matrix rests on and what it
 * does not, so the total reconciles arithmetically.
 *
 * `publishedBatchIds` is the set of batch ids the surviving lanes and judge
 * passes actually used. Anything else on a batch channel was paid for by an
 * attempt that was cancelled or superseded.
 */
export function reconcileSpend(
  ledger: LedgerFile,
  publishedBatchIds: Set<string>,
): SpendReconciliation {
  let published = 0;
  const supersededByLane = new Map<string, number>();
  let reconciled = 0;

  for (const entry of ledger.entries) {
    if (entry.key.endsWith(":reconciled")) {
      reconciled += entry.cost_usd;
      continue;
    }
    if (entry.channel === "interactive") {
      published += entry.cost_usd;
      continue;
    }
    const batchId = entry.key.split(":")[0];
    if (publishedBatchIds.has(batchId)) {
      published += entry.cost_usd;
    } else {
      supersededByLane.set(
        entry.lane,
        (supersededByLane.get(entry.lane) ?? 0) + entry.cost_usd,
      );
    }
  }

  const superseded = [...supersededByLane.entries()].map(([lane, cost]) => ({
    label: lane,
    cost_usd: cost,
    reason:
      "spent by a run attempt that was cancelled or restarted; the batches " +
      "completed and were billed, but their results are not in this matrix",
  }));
  if (reconciled > 0) {
    superseded.push({
      label: "manual reconciliation",
      cost_usd: reconciled,
      reason:
        "a batch that completed and was billed before a retrieval bug threw; " +
        "usage re-fetched from the API and recorded so the envelope is honest",
    });
  }

  const total = published + superseded.reduce((a, s) => a + s.cost_usd, 0);
  return {
    ledger_total_usd: ledger.totals.cost_usd,
    published_usd: published,
    superseded,
    // Cent tolerance: entry costs are floats and the ledger sums them.
    reconciles: Math.abs(total - ledger.totals.cost_usd) < 0.005,
  };
}

export function renderCacheSection(lanes: LaneCacheStats[]): string {
  const cached = lanes.filter((lane) => lane.lane.endsWith(":cached"));
  if (cached.length === 0) return "";
  const lines = [
    "## Cache behaviour, round by round",
    "",
    "The cached column is only a saving while the 1h TTL survives the gap",
    "between batch rounds. Where it does, reads dominate and the lane is",
    "cheaper; where a round cadence exceeds the TTL, every round pays a 2x",
    "write instead of a 0.1x read and caching inverts. Both outcomes are",
    "reported here as measured.",
    "",
    "| lane | round | requests | cache read tok | cache write tok | reads dominate |",
    "| --- | ---: | ---: | ---: | ---: | :--- |",
  ];
  for (const lane of cached) {
    for (const round of lane.rounds) {
      lines.push(
        `| \`${lane.lane}\` | ${round.round} | ${round.requests} | ` +
          `${round.cache_read_tokens} | ${round.cache_write_tokens} | ` +
          `${round.round === 0 ? "n/a (first round always writes)" : round.reads_dominate ? "yes" : "NO"} |`,
      );
    }
  }
  lines.push("");
  for (const lane of cached) {
    // A lane whose FIRST round pays reads instead of writes did not start
    // cold: it inherited a prefix an earlier attempt wrote and paid for.
    // Measured on claude-opus-5:cached, 2026-08-12, where round 0 read 5,702
    // cached tokens per request and wrote none because a superseded attempt
    // had written that prefix inside the 1h TTL. Its cache economics are then
    // cheaper than a from-cold lane's and must not be quoted as one: the
    // write is real, and it is sitting in the superseded bucket of the spend
    // reconciliation.
    const first = lane.rounds.find((round) => round.round === 0);
    if (
      first !== undefined &&
      first.cache_write_tokens === 0 &&
      first.cache_read_tokens > 0
    ) {
      lines.push(
        `- \`${lane.lane}\`: NOT A FROM-COLD MEASUREMENT. Round 0 read ` +
          `${first.cache_read_tokens} cached tokens and wrote none, so the ` +
          "prefix was already warm from an earlier attempt that paid for the " +
          "write. This lane's cost understates a cold cached lane by that write.",
      );
    }
    lines.push(
      lane.cache_inverted
        ? `- \`${lane.lane}\`: caching INVERTED. ${lane.cache_write_tokens} write tokens against ` +
            `${lane.cache_read_tokens} read tokens, so this lane cost more than it saved. ` +
            "At this round cadence the 1h TTL expired between rounds."
        : `- \`${lane.lane}\`: caching held. ${lane.cache_read_tokens} read tokens against ` +
            `${lane.cache_write_tokens} written` +
            (lane.rounds_without_cache_benefit > 0
              ? `, though ${lane.rounds_without_cache_benefit} later round(s) missed the cache.`
              : "."),
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderSpendSection(spend: SpendReconciliation): string {
  const lines = [
    "## Spend reconciliation",
    "",
    `Ledger total: $${spend.ledger_total_usd.toFixed(4)}.`,
    `Attributable to this matrix: $${spend.published_usd.toFixed(4)}.`,
    "",
  ];
  if (spend.superseded.length > 0) {
    lines.push(
      "Real spend that bought nothing published, itemised rather than folded",
      "into the total:",
      "",
    );
    for (const entry of spend.superseded) {
      lines.push(
        `- \`${entry.label}\`: $${entry.cost_usd.toFixed(4)} — ${entry.reason}`,
      );
    }
    lines.push("");
  }
  lines.push(
    spend.reconciles
      ? "Published plus superseded equals the ledger total."
      : "WARNING: the split does not reconcile against the ledger total.",
    "",
  );
  return lines.join("\n");
}

/** Bounds the region of the README that `matrix:augment` owns and rewrites. */
const GENERATED_MARKER = "<!-- generated by matrix:augment -->";

/** Heading of the first generated section, for a README written pre-marker. */
const FIRST_GENERATED_HEADING = "\n## Cache behaviour, round by round";

const SPEND_LINE = /^Actual: \$[\d.]+ against a \$[\d.]+ envelope\.$/m;

function stripGeneratedSections(readme: string): string {
  for (const boundary of [GENERATED_MARKER, FIRST_GENERATED_HEADING]) {
    const at = readme.indexOf(boundary);
    if (at !== -1) return readme.slice(0, at);
  }
  return readme;
}

/**
 * Rewrites the augment-owned tail of the README and the spend line above it.
 *
 * Two defects this closes. Appending to whatever was already in the file made
 * a second augment run publish the cache and reconciliation tables twice, so
 * the region is bounded and replaced instead. And the `Actual: $X` line is
 * rendered at RUN time from the totals as they stood then, so a later sweep
 * left it contradicting the reconciliation table further down the same
 * document; it is re-rendered here from the ledger the tables are computed
 * from. A README with no spend line to rewrite throws rather than silently
 * publishing the stale figure, which is the failure this is fixing.
 */
export function renderAugmentedReadme(
  readme: string,
  ledger: LedgerFile,
  sections: string,
): string {
  const base = stripGeneratedSections(readme);
  if (!SPEND_LINE.test(base)) {
    throw new Error("augment: no spend line found to refresh in the README");
  }
  const refreshed = base.replace(
    SPEND_LINE,
    `Actual: $${ledger.totals.cost_usd.toFixed(2)} against a ` +
      `$${ledger.envelope_hard_usd} envelope.`,
  );
  return `${refreshed.trimEnd()}\n\n${GENERATED_MARKER}\n${sections}`;
}
