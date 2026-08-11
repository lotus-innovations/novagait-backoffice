// Layer 2, programmatic-fuzzy (spec 09 §2). Two jobs: accept equivalent
// normalized forms that layer 1 rightly rejected as inexact (credit), and
// grade the normalizations that layer 1 cannot express (date parsing).
//
// A credit turns a layer-1 failure into a non-failure; a refused credit adds
// NOTHING, because the layer-1 miss is already counted. Layer 2 only ever
// adds a failure of its own for a check layer 1 does not run at all.

import {
  VENDOR_MATCH_THRESHOLD,
  resolveVendorName,
  type VendorCandidate,
} from "@novagait/agent";
import type { GoldenCase } from "../golden";
import { normalizeCurrency, normalizeDate } from "../normalize";
import type { RunOutcome } from "../outcome";
import { assertKnownCode } from "../taxonomy";
import { failCheck, passCheck, skipCheck, type CheckResult } from "./types";

export interface FuzzyOptions {
  // ERP canonical vendor list. Without it the vendor-resolution credit
  // cannot run and is reported as not_applicable rather than silently
  // passing: a credit nobody could compute must not look like a match.
  vendors?: readonly VendorCandidate[];
}

const DATE_FIELDS = ["invoice_date", "due_date"] as const;

function failed(layer1: CheckResult[], id: string): boolean {
  return layer1.some((check) => check.id === id && check.status === "fail");
}

function gradeVendorResolution(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  layer1: CheckResult[],
  options: FuzzyOptions,
): CheckResult {
  const id = "vendor_resolution";
  const expected = goldenCase.expected.fields.vendor_id;
  if (!failed(layer1, "field:vendor_id")) {
    return skipCheck(id, 2, "vendor_id matched exactly; no credit needed");
  }
  if (expected === null) {
    return skipCheck(
      id,
      2,
      "case expects an unresolved vendor; no credit path",
    );
  }
  if (!options.vendors) {
    return skipCheck(id, 2, "no vendor catalog supplied");
  }
  const raw = outcome.fields.vendor_name_raw;
  if (raw === null) {
    return skipCheck(id, 2, "run recorded no raw vendor name to resolve");
  }
  const resolution = resolveVendorName(raw, [...options.vendors]);
  if (
    resolution.vendor_id === expected &&
    resolution.score >= VENDOR_MATCH_THRESHOLD
  ) {
    return passCheck(
      id,
      2,
      `"${raw}" resolves to ${expected} (${resolution.method}, score ${resolution.score.toFixed(3)} >= ${VENDOR_MATCH_THRESHOLD})`,
      ["field:vendor_id"],
    );
  }
  return skipCheck(
    id,
    2,
    `"${raw}" does not resolve to ${expected} (best ${String(resolution.vendor_id)}, score ${resolution.score.toFixed(3)})`,
  );
}

function gradeCurrencyParse(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  layer1: CheckResult[],
): CheckResult {
  const id = "currency_parse";
  const expected = goldenCase.expected.fields.currency;
  if (!failed(layer1, "field:currency")) {
    return skipCheck(id, 2, "currency matched exactly; no credit needed");
  }
  if (expected === null) {
    return skipCheck(id, 2, "case expects no currency; no credit path");
  }
  const parsedExpected = normalizeCurrency(expected);
  const parsedActual = normalizeCurrency(outcome.fields.currency);
  if (parsedActual !== null && parsedActual === parsedExpected) {
    return passCheck(
      id,
      2,
      `"${String(outcome.fields.currency)}" parses to ${parsedActual}`,
      ["field:currency"],
    );
  }
  return skipCheck(
    id,
    2,
    `"${String(outcome.fields.currency)}" does not parse to ${String(parsedExpected)}`,
  );
}

function gradeDateNormalization(outcome: RunOutcome): CheckResult {
  const id = "date_normalization";
  const present = DATE_FIELDS.filter((key) => outcome.fields[key] !== null);
  if (present.length === 0) {
    return skipCheck(id, 2, "run recorded no dates");
  }
  const unparseable = present.filter(
    (key) => normalizeDate(outcome.fields[key]) === null,
  );
  if (unparseable.length > 0) {
    return failCheck(
      id,
      2,
      assertKnownCode("EXT-002"),
      unparseable
        .map(
          (key) =>
            `${key}="${String(outcome.fields[key])}" is not a recognizable date`,
        )
        .join("; "),
    );
  }
  return passCheck(
    id,
    2,
    present
      .map((key) => `${key} -> ${String(normalizeDate(outcome.fields[key]))}`)
      .join("; "),
  );
}

export function gradeFuzzy(
  goldenCase: GoldenCase,
  outcome: RunOutcome,
  layer1: CheckResult[],
  options: FuzzyOptions = {},
): CheckResult[] {
  return [
    gradeVendorResolution(goldenCase, outcome, layer1, options),
    gradeCurrencyParse(goldenCase, outcome, layer1),
    gradeDateNormalization(outcome),
  ];
}
