// Entrypoint: npm run -w @novagait/evals-runner cassettes:record
// CASSETTE_OUT_DIR redirects the write (CI records to a scratch dir).
import { test } from "vitest";
import { recordCassettes } from "./record";
import { CASSETTE_DIR } from "./paths";

test("record cassettes for every golden case", async () => {
  const outDir = process.env.CASSETTE_OUT_DIR ?? CASSETTE_DIR;
  const cassettes = await recordCassettes({ outDir });
  console.info(`recorded ${cassettes.length} cassettes -> ${outDir}`);
});
