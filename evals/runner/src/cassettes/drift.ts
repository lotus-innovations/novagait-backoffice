// Harness-drift check: re-record every cassette into a scratch directory and
// compare it to the committed one. A code change that alters the mock lane
// therefore fails CI at the cassette, before it can quietly move the
// baseline. Comparison is on the canonical serialization, not raw bytes:
// on-disk formatting belongs to repo-wide prettier.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, cassetteFileName, parseCassette } from "./cassette";
import { recordCassettes } from "./record";
import { CASSETTE_DIR, GOLDEN_DIR } from "./paths";

export interface DriftOptions {
  goldenDir?: string;
  committedDir?: string;
  outDir?: string;
}

export async function cassetteDrift(
  options: DriftOptions = {},
): Promise<string[]> {
  const committedDir = options.committedDir ?? CASSETTE_DIR;
  const outDir =
    options.outDir ?? (await mkdtemp(join(tmpdir(), "novagait-cassettes-")));
  const problems: string[] = [];
  try {
    const fresh = await recordCassettes({
      goldenDir: options.goldenDir ?? GOLDEN_DIR,
      outDir,
      prune: false,
    });
    for (const cassette of fresh) {
      const name = cassetteFileName(cassette.case_id);
      let committed: string;
      try {
        committed = await readFile(join(committedDir, name), "utf8");
      } catch {
        problems.push(`${name}: no committed cassette`);
        continue;
      }
      const recorded = await readFile(join(outDir, name), "utf8");
      if (
        canonicalize(parseCassette(committed, name)) !==
        canonicalize(parseCassette(recorded, name))
      ) {
        problems.push(
          `${name}: re-recorded cassette differs from the committed one`,
        );
      }
    }
  } finally {
    if (!options.outDir) await rm(outDir, { recursive: true, force: true });
  }
  return problems;
}
