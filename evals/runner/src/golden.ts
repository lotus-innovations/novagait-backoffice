// Golden-case schema + loader (spec 09 §1). One JSON file per case in
// evals/golden/. The validator here is the shakedown: every schema
// ambiguity a case exposes goes back into spec 07 as a rule, not resolved
// ad hoc in the case file.

import { readdir, readFile } from "node:fs/promises";
import { TOOL_NAMES } from "@novagait/agent";
import { join } from "node:path";

export const DECISIONS = [
  "auto_approve",
  "route_for_approval",
  "exception_hold",
  "reject",
] as const;
export type Decision = (typeof DECISIONS)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

// The agent tool surface is single-sourced from the agent package
// (LOT-89): a golden case cannot reference a tool that does not exist.
export const KNOWN_TOOLS = TOOL_NAMES;

export interface GoldenExpectedFields {
  vendor_id: string | null;
  invoice_number: string | null;
  total_cents: number | null;
  currency: string | null;
  po_reference: string | null;
}

export interface GoldenCase {
  id: string; // INV-xxx
  tags: string[];
  difficulty: Difficulty;
  input: { fixture: string };
  expected: {
    fields: GoldenExpectedFields;
    decision: Decision;
    tool_calls: string[];
    must_not_call: string[];
    guardrail: string | null;
  };
  notes: string;
}

export interface GoldenValidation {
  valid: boolean;
  errors: string[];
}

const FIELD_KEYS: (keyof GoldenExpectedFields)[] = [
  "vendor_id",
  "invoice_number",
  "total_cents",
  "currency",
  "po_reference",
];

export function validateGoldenCase(candidate: unknown): GoldenValidation {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (candidate === null || typeof candidate !== "object") {
    return { valid: false, errors: ["case is not an object"] };
  }
  const goldenCase = candidate as Record<string, unknown>;

  if (typeof goldenCase.id !== "string" || !/^INV-\d{3}$/.test(goldenCase.id)) {
    fail(`id must match INV-xxx: ${String(goldenCase.id)}`);
  }
  if (
    !Array.isArray(goldenCase.tags) ||
    goldenCase.tags.length === 0 ||
    !goldenCase.tags.every((tag) => typeof tag === "string")
  ) {
    fail("tags must be a non-empty string array");
  }
  if (!DIFFICULTIES.includes(goldenCase.difficulty as Difficulty)) {
    fail(`difficulty must be one of ${DIFFICULTIES.join("|")}`);
  }
  const input = goldenCase.input as Record<string, unknown> | undefined;
  if (!input || typeof input.fixture !== "string") {
    fail("input.fixture is required");
  }
  if (typeof goldenCase.notes !== "string" || goldenCase.notes.length < 10) {
    fail("notes must explain the case (min 10 chars)");
  }

  const expected = goldenCase.expected as Record<string, unknown> | undefined;
  if (!expected) {
    fail("expected is required");
    return { valid: false, errors };
  }
  if (!DECISIONS.includes(expected.decision as Decision)) {
    fail(`expected.decision must be one of ${DECISIONS.join("|")}`);
  }
  const fields = expected.fields as Record<string, unknown> | undefined;
  if (!fields) {
    fail("expected.fields is required");
  } else {
    for (const key of FIELD_KEYS) {
      if (!(key in fields)) fail(`expected.fields.${key} must be present`);
    }
    if (fields.total_cents !== null && !Number.isInteger(fields.total_cents)) {
      fail("expected.fields.total_cents must be an integer or null");
    }
  }
  for (const listName of ["tool_calls", "must_not_call"] as const) {
    const list = expected[listName];
    if (!Array.isArray(list)) {
      fail(`expected.${listName} must be an array`);
      continue;
    }
    for (const tool of list) {
      if (!KNOWN_TOOLS.includes(tool as (typeof KNOWN_TOOLS)[number])) {
        fail(`expected.${listName} references unknown tool: ${String(tool)}`);
      }
    }
  }
  if (
    Array.isArray(expected.tool_calls) &&
    Array.isArray(expected.must_not_call)
  ) {
    const overlap = expected.tool_calls.filter((tool) =>
      (expected.must_not_call as string[]).includes(tool as string),
    );
    if (overlap.length > 0) {
      fail(`tool_calls and must_not_call overlap: ${overlap.join(", ")}`);
    }
  }
  if (
    expected.guardrail !== null &&
    (typeof expected.guardrail !== "string" ||
      !/^GR-[A-Z]+$/.test(expected.guardrail))
  ) {
    fail("expected.guardrail must be null or a GR-* rule id");
  }

  return { valid: errors.length === 0, errors };
}

export async function loadGoldenCases(dir: string): Promise<GoldenCase[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const cases: GoldenCase[] = [];
  for (const file of files.sort()) {
    const parsed = JSON.parse(await readFile(join(dir, file), "utf8"));
    const validation = validateGoldenCase(parsed);
    if (!validation.valid) {
      throw new Error(`${file}: ${validation.errors.join("; ")}`);
    }
    cases.push(parsed as GoldenCase);
  }
  return cases;
}
