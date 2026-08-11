// Normalizers shared by the deterministic and fuzzy layers. Layer 1 uses
// only normalizeToken (trim + case + whitespace); the parsing normalizers
// (currency, date) are layer 2 by design, so the published numbers say which
// matches were exact and which needed help.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const CURRENCY_ALIASES: Record<string, string> = {
  $: "USD",
  us$: "USD",
  usd: "USD",
  dollar: "USD",
  dollars: "USD",
  "us dollar": "USD",
  "us dollars": "USD",
  "€": "EUR",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "£": "GBP",
  gbp: "GBP",
  pound: "GBP",
  pounds: "GBP",
  c$: "CAD",
  cad: "CAD",
};

// Empty and whitespace-only values collapse to null: "the model wrote an
// empty string" and "the model wrote nothing" are the same extraction
// failure, and grading them differently would inflate EXT-002.
export function normalizeToken(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ").toUpperCase();
  return collapsed === "" ? null : collapsed;
}

export function normalizeCurrency(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (raw === "") return null;
  const alias = CURRENCY_ALIASES[raw];
  if (alias) return alias;
  return /^[a-z]{3}$/.test(raw) ? raw.toUpperCase() : null;
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > days) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Accepts the forms that actually appear on the fixtures: ISO, US slash,
// dotted, and "11 Mar 2026" / "Mar 11, 2026". US convention (month first)
// is assumed for numeric slash dates, matching spec 07's document set;
// ambiguous non-US layouts are a labeling note on the case, not a parse.
export function normalizeDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const usMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
  if (usMatch) {
    return iso(Number(usMatch[3]), Number(usMatch[1]), Number(usMatch[2]));
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(raw);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    return month ? iso(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }

  const monthFirst = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    return month
      ? iso(Number(monthFirst[3]), month, Number(monthFirst[2]))
      : null;
  }

  return null;
}

// expected.tool_calls must appear in order, but other calls may interleave:
// the golden cases assert a required spine, not an exhaustive transcript.
export function isOrderedSubsequence(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  let cursor = 0;
  for (const name of actual) {
    if (cursor < expected.length && name === expected[cursor]) cursor++;
  }
  return cursor === expected.length;
}
