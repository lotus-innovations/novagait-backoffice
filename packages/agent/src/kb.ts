// Policy knowledge base (spec 07 §9, arch doc E). The kb/*.md files are the
// source of truth, compiled into kb.generated.ts (fixtures pattern: no
// runtime fs reads). Retrieval over these docs lives in retrieval.ts;
// explicitly no vector database.

import { KB_FILES } from "./kb.generated";

export interface KbDoc {
  /** Stable id derived from the filename, e.g. "price-tolerance". */
  id: string;
  /** Human-readable title from the first `# ` heading. */
  title: string;
  /** Full markdown body. */
  content: string;
}

let cache: KbDoc[] | null = null;

export function loadKb(): KbDoc[] {
  if (cache) return cache;
  cache = Object.entries(KB_FILES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, content]) => {
      const heading = content.match(/^#\s+(.+)$/m);
      return {
        id: file.replace(/\.md$/, ""),
        title: heading ? heading[1].trim() : file,
        content,
      };
    });
  return cache;
}

export function __resetKbCacheForTests() {
  cache = null;
}
