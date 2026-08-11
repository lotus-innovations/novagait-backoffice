import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkAgainstBaseline,
  coverageProblems,
  diffValues,
  failingCaseIds,
  loadCassettes,
  replay,
} from "./replay";
import { CASSETTE_DIR } from "./paths";
import { loadGoldenCases } from "../golden";
import { GOLDEN_DIR } from "./paths";

const scratch: string[] = [];
async function copyCassettes(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "novagait-replay-test-"));
  scratch.push(dir);
  await cp(CASSETTE_DIR, dir, { recursive: true });
  return dir;
}
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("replay comparator", () => {
  it("matches the committed baseline exactly", async () => {
    const { diffs, summary } = await checkAgainstBaseline();
    expect(diffs).toEqual([]);
    expect(summary.total).toBe(73);
    expect(summary.lane).toBe("mock-replay");
  });

  it("reports a readable diff when the summary drifts", async () => {
    const { summary, baseline } = await checkAgainstBaseline();
    const drifted = {
      ...summary,
      passed: summary.passed + 1,
      cases: summary.cases.map((entry, index) =>
        index === 0 ? { ...entry, pass: !entry.pass } : entry,
      ),
    };
    const diffs = diffValues(drifted, baseline.summary);
    expect(diffs).toContain(
      `summary.passed: expected ${summary.passed}, got ${summary.passed + 1}`,
    );
    expect(diffs.some((line) => line.startsWith("summary.cases.0.pass:"))).toBe(
      true,
    );
  });

  it("names added and removed keys instead of dumping both blobs", () => {
    const diffs = diffValues(
      { kept: 1, extra: 2 },
      { kept: 1, missing: 3 },
      "summary",
    );
    expect(diffs).toEqual([
      "summary.extra: unexpected 2",
      "summary.missing: missing (baseline has 3)",
    ]);
  });

  it("fails when a golden case has no cassette", async () => {
    const dir = await copyCassettes();
    await rm(join(dir, "INV-042.json"));
    await expect(replay({ cassetteDir: dir })).rejects.toThrow(
      /golden INV-042 has no cassette/,
    );
  });

  it("fails when a cassette has no golden case", async () => {
    const dir = await copyCassettes();
    const orphan = JSON.parse(
      JSON.stringify((await loadCassettes(dir))[0]),
    ) as Record<string, unknown>;
    orphan.case_id = "INV-999";
    await writeFile(join(dir, "INV-999.json"), JSON.stringify(orphan), "utf8");
    await expect(replay({ cassetteDir: dir })).rejects.toThrow(
      /cassette INV-999 has no golden case/,
    );
  });

  it("reports coverage gaps in both directions at once", async () => {
    const cases = await loadGoldenCases(GOLDEN_DIR);
    const cassettes = await loadCassettes(CASSETTE_DIR);
    expect(coverageProblems(cases, cassettes)).toEqual([]);
    expect(coverageProblems(cases.slice(1), cassettes.slice(0, -1))).toEqual([
      `cassette ${cases[0]!.id} has no golden case`,
      `golden ${cases.at(-1)!.id} has no cassette (${cases.at(-1)!.id}.json)`,
    ]);
  });

  it("grades every case exactly once", async () => {
    const { results, summary } = await replay();
    expect(results).toHaveLength(73);
    expect(new Set(failingCaseIds(summary)).size).toBe(
      summary.total - summary.passed,
    );
  });
});
