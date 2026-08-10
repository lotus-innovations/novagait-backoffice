// Dependency-free chunked BM25 retrieval over the policy kb (arch doc E:
// Demo 2 retrieval.ts pattern, no embeddings service, no vector DB).
// Documents split on `##` headings; each chunk keeps its parent document
// title and section so kb_search results cite their source.

import { loadKb, type KbDoc } from "./kb";

export interface Chunk {
  docId: string;
  docTitle: string;
  /** Section heading, or the doc title for the preamble chunk. */
  section: string;
  text: string;
}

export interface RetrievedChunk extends Chunk {
  score: number;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from has have how i if in is it " +
    "my of on or our the this to we what when where which will with you your"
  ).split(" "),
);

/** Light plural/suffix normalization so "invoices" matches "invoice". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies"))
    return `${token.slice(0, -3)}y`;
  // Strip "es" only after sibilants (matches -> match, boxes -> box);
  // elsewhere strip the bare "s" so invoices -> invoice, codes -> code.
  if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token))
    return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss"))
    return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

export function chunkDoc(doc: KbDoc): Chunk[] {
  const parts = doc.content.split(/^##\s+/m);
  const chunks: Chunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    if (i === 0) {
      // Preamble: title line + any intro text before the first ## heading.
      const body = raw.replace(/^#\s+.+$/m, "").trim();
      if (body) {
        chunks.push({
          docId: doc.id,
          docTitle: doc.title,
          section: doc.title,
          text: body,
        });
      }
    } else {
      const newline = raw.indexOf("\n");
      const section = newline === -1 ? raw : raw.slice(0, newline).trim();
      const body = newline === -1 ? "" : raw.slice(newline + 1).trim();
      chunks.push({
        docId: doc.id,
        docTitle: doc.title,
        section,
        // Prefix the section so heading terms are indexed with the body.
        text: `${section}. ${body}`.trim(),
      });
    }
  }
  return chunks;
}

interface IndexedChunk {
  chunk: Chunk;
  terms: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private chunks: IndexedChunk[] = [];
  private docFreq = new Map<string, number>();
  private avgLength = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(docs: KbDoc[]) {
    for (const doc of docs) {
      for (const chunk of chunkDoc(doc)) {
        const tokens = tokenize(`${chunk.docTitle} ${chunk.text}`);
        const terms = new Map<string, number>();
        for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
        this.chunks.push({ chunk, terms, length: tokens.length });
        for (const t of terms.keys()) {
          this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
        }
      }
    }
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    this.avgLength = this.chunks.length ? total / this.chunks.length : 0;
  }

  get size() {
    return this.chunks.length;
  }

  search(query: string, topK = 6): RetrievedChunk[] {
    const qTerms = [...new Set(tokenize(query))];
    const n = this.chunks.length;
    const scored: RetrievedChunk[] = [];
    for (const { chunk, terms, length } of this.chunks) {
      let score = 0;
      for (const q of qTerms) {
        const tf = terms.get(q);
        if (!tf) continue;
        const df = this.docFreq.get(q) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score +=
          (idf * tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + (this.b * length) / this.avgLength));
      }
      if (score > 0) scored.push({ ...chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

let indexCache: Bm25Index | null = null;

export function getKbIndex(): Bm25Index {
  if (!indexCache) indexCache = new Bm25Index(loadKb());
  return indexCache;
}

export function __resetKbIndexForTests() {
  indexCache = null;
}

/** Citation format used everywhere a kb excerpt is shown: "Doc Title §Section". */
export function citationOf(chunk: Chunk): string {
  return chunk.section === chunk.docTitle
    ? chunk.docTitle
    : `${chunk.docTitle} §${chunk.section}`;
}

export interface KbSearchResult {
  citation: string;
  doc_id: string;
  excerpt: string;
  score: number;
}

/**
 * The kb_search tool executor body: top-k excerpts with citations, ready to
 * serialize as the tool result. Excerpts are whole chunks (policy sections
 * are short by construction).
 */
export function searchKb(query: string, topK = 3): KbSearchResult[] {
  return getKbIndex()
    .search(query, topK)
    .map((chunk) => ({
      citation: citationOf(chunk),
      doc_id: chunk.docId,
      excerpt: chunk.text,
      score: Number(chunk.score.toFixed(3)),
    }));
}
