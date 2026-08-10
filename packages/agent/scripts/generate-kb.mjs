// Compiles kb/*.md into src/kb.generated.ts so the policy corpus is
// bundler-safe (Turbopack/serverless: no runtime fs). The files on disk
// remain the source of truth; a unit test fails on drift.
// Regenerate: npm run gen:kb -w @novagait/agent
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "kb");
const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
const entries = [];
for (const file of files) {
  const text = await readFile(join(dir, file), "utf8");
  entries.push(`  ${JSON.stringify(file)}: ${JSON.stringify(text)},`);
}
const out = `// GENERATED FILE - do not edit by hand.
// Source of truth: packages/agent/kb/*.md
// Regenerate: npm run gen:kb -w @novagait/agent

export const KB_FILES: Record<string, string> = {
${entries.join("\n")}
};
`;
await writeFile(join(root, "src", "kb.generated.ts"), out);
console.log(`generated ${files.length} kb docs`);
