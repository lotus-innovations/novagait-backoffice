// Drift gate: the generated fixture module must match the files on disk.
// If a fixture is edited without regenerating, this fails CI.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures.generated";

const DIR = fileURLToPath(new URL("../fixtures/inbox", import.meta.url));

describe("fixtures.generated", () => {
  it("matches fixtures/inbox/*.md exactly", async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".md")).sort();
    expect(Object.keys(FIXTURES).sort()).toEqual(
      files.map((f) => `inbox/${f}`),
    );
    for (const file of files) {
      expect(FIXTURES[`inbox/${file}`], file).toBe(
        await readFile(join(DIR, file), "utf8"),
      );
    }
  });
});
