import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalize,
  cassetteFileName,
  cassetteRunId,
  normalizeOutcome,
  parseCassette,
  serializeCassette,
  type Cassette,
} from "./cassette";
import { PRE_SEED_RUNS, recordCassettes, toCassette } from "./record";
import { loadCassettes } from "./replay";
import { CASSETTE_DIR, GOLDEN_DIR } from "./paths";
import { EMPTY_FIELDS, type RunOutcome } from "../outcome";

const scratch: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "novagait-cassette-test-"));
  scratch.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const outcome = (overrides: Partial<RunOutcome> = {}): RunOutcome => ({
  case_id: "INV-999",
  run_id: "01JABCDEFGHJKMNPQRSTVWXYZ",
  model: "mock-agent",
  mode: "autonomous",
  fields: { ...EMPTY_FIELDS },
  decision: "exception_hold",
  tool_calls: ["lookup_vendor", "draft_action"],
  guardrails_fired: [],
  drafted_action_text: "held",
  output_schema_valid: true,
  schema_errors: [],
  terminal_state: "held",
  failure_code: null,
  error_events: [],
  ...overrides,
});

describe("cassette normalization", () => {
  it("replaces the volatile run id with a case-derived one", () => {
    const normalized = normalizeOutcome(outcome(), "INV-042");
    expect(normalized.run_id).toBe(cassetteRunId("INV-042"));
    expect(normalized.case_id).toBe("INV-042");
  });

  it("maps the mock parser's null sentinels to null", () => {
    const normalized = normalizeOutcome(
      outcome({
        fields: {
          ...EMPTY_FIELDS,
          invoice_number: "UNKNOWN",
          total_cents: 0,
        },
      }),
      "INV-039",
    );
    expect(normalized.fields.invoice_number).toBeNull();
    expect(normalized.fields.total_cents).toBeNull();
  });

  it("leaves real extracted values alone", () => {
    const normalized = normalizeOutcome(
      outcome({
        fields: { ...EMPTY_FIELDS, invoice_number: "CB-1", total_cents: 100 },
      }),
      "INV-001",
    );
    expect(normalized.fields.invoice_number).toBe("CB-1");
    expect(normalized.fields.total_cents).toBe(100);
  });

  it("round-trips through serialize -> parse unchanged", () => {
    const cassette = toCassette(outcome(), "INV-001");
    const restored = parseCassette(serializeCassette(cassette), "INV-001.json");
    expect(restored).toEqual(JSON.parse(JSON.stringify(cassette)));
    expect(serializeCassette(restored)).toBe(serializeCassette(cassette));
  });

  it("serializes independently of key insertion order", () => {
    const a = toCassette(outcome(), "INV-001");
    const reversed = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as Cassette;
    expect(serializeCassette(reversed)).toBe(serializeCassette(a));
    expect(canonicalize(reversed)).toBe(canonicalize(a));
  });

  it("rejects a file that is not a mock-replay cassette", () => {
    expect(() => parseCassette(JSON.stringify({ case_id: "INV-001" }), "x")) //
      .toThrow(/lane must be mock-replay/);
    expect(() => parseCassette(JSON.stringify({ lane: "mock-replay" }), "x")) //
      .toThrow(/case_id is required/);
  });
});

describe("recorder determinism", () => {
  it("produces byte-identical cassettes on a re-record", async () => {
    const first = await tempDir();
    const second = await tempDir();
    await recordCassettes({ goldenDir: GOLDEN_DIR, outDir: first });
    await recordCassettes({ goldenDir: GOLDEN_DIR, outDir: second });
    const names = (await readdir(first)).sort();
    expect(names.length).toBe(73);
    for (const name of names) {
      expect(await readFile(join(second, name), "utf8"), name).toBe(
        await readFile(join(first, name), "utf8"),
      );
    }
  });

  it("records one cassette per golden case, each carrying provenance", async () => {
    const cassettes = await loadCassettes(CASSETTE_DIR);
    expect(cassettes).toHaveLength(73);
    for (const cassette of cassettes) {
      expect(cassetteFileName(cassette.case_id)).toMatch(/^INV-\d{3}\.json$/);
      expect(cassette.pipeline).toBe("deterministic");
      expect(cassette.recorded_with.model).toBe("mock-agent");
      expect(cassette.recorded_with.prompt_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(cassette.recorded_with.tools_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(cassette.outcome.run_id).toBe(cassetteRunId(cassette.case_id));
    }
  });
});

describe("recording order", () => {
  // The one cross-case dependency in the set: INV-010's GR-DUP exists only
  // because INV-001 posted CB-2026-0803 to the ledger first (PRE_SEED_RUNS).
  it("records INV-010 with its duplicate guardrail fired", async () => {
    const cassettes = await loadCassettes(CASSETTE_DIR);
    const dup = cassettes.find((entry) => entry.case_id === "INV-010");
    expect(dup?.outcome.guardrails_fired).toEqual(["GR-DUP"]);
    expect(dup?.outcome.decision).toBe("exception_hold");
  });

  it("records every other case from freshly seeded state", async () => {
    expect(Object.keys(PRE_SEED_RUNS)).toEqual(["INV-010"]);
    expect(PRE_SEED_RUNS["INV-010"]).toEqual(["INV-001"]);
  });
});
