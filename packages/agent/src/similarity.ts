// Jaro-Winkler similarity + vendor-name resolution (spec 07 §5). The
// threshold lives in policy-constants; GR-VENDOR and the executors share
// this exact implementation so the eval numbers describe production code.

import { VENDOR_MATCH_THRESHOLD } from "./policy-constants";

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  return (
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

export function jaroWinkler(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);
  const base = jaro(a, b);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return base + prefix * 0.1 * (1 - base);
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(llc|inc|corp|co|ltd)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VendorCandidate {
  id: string;
  canonical_name: string;
}

export interface VendorResolution {
  vendor_id: string | null;
  canonical_name: string | null;
  score: number;
  method: "exact" | "fuzzy" | "unresolved";
}

export function resolveVendorName(
  nameRaw: string,
  vendors: VendorCandidate[],
): VendorResolution {
  let best: { vendor: VendorCandidate; score: number } | null = null;
  for (const vendor of vendors) {
    const score = jaroWinkler(nameRaw, vendor.canonical_name);
    if (!best || score > best.score) best = { vendor, score };
  }
  if (!best)
    return {
      vendor_id: null,
      canonical_name: null,
      score: 0,
      method: "unresolved",
    };
  if (normalizeName(nameRaw) === normalizeName(best.vendor.canonical_name)) {
    return {
      vendor_id: best.vendor.id,
      canonical_name: best.vendor.canonical_name,
      score: 1,
      method: "exact",
    };
  }
  if (best.score >= VENDOR_MATCH_THRESHOLD) {
    return {
      vendor_id: best.vendor.id,
      canonical_name: best.vendor.canonical_name,
      score: best.score,
      method: "fuzzy",
    };
  }
  return {
    vendor_id: null,
    canonical_name: null,
    score: best.score,
    method: "unresolved",
  };
}
