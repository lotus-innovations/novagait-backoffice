// Compiles fixtures/inbox/*.md into src/fixtures.generated.ts so the mock
// backend is bundler-safe (Turbopack/serverless: no runtime fs). The files
// on disk remain the source of truth; a unit test fails on drift.
// Regenerate: npm run gen:fixtures -w @novagait/mock-backend
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "fixtures", "inbox");
const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
const entries = [];
for (const file of files) {
  const text = await readFile(join(dir, file), "utf8");
  entries.push(
    `  ${JSON.stringify(`inbox/${file}`)}: ${JSON.stringify(text)},`,
  );
}
const out = `// GENERATED FILE - do not edit by hand.
// Source of truth: packages/mock-backend/fixtures/inbox/*.md
// Regenerate: npm run gen:fixtures -w @novagait/mock-backend

export const FIXTURES: Record<string, string> = {
${entries.join("\n")}
};
`;
await writeFile(join(root, "src", "fixtures.generated.ts"), out);
console.log(`generated ${files.length} fixtures`);
