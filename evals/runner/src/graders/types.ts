// Shared grader vocabulary. Every check a layer runs reports itself the same
// way so the report page can render layers 1 and 2 from one list and the
// taxonomy assignment can read `code` without knowing which layer produced
// it.

export type CheckStatus = "pass" | "fail" | "not_applicable";

export interface CheckResult {
  id: string;
  layer: 1 | 2;
  status: CheckStatus;
  // Taxonomy code when status === "fail"; null otherwise.
  code: string | null;
  detail: string;
  // Layer 2 only: ids of layer-1 checks this result repairs. A credited
  // layer-1 failure does not count against pass/fail (spec 09 §2: the fuzzy
  // layer exists to accept equivalent forms, not to add a second penalty).
  credits?: string[];
}

export function passCheck(
  id: string,
  layer: 1 | 2,
  detail: string,
  credits?: string[],
): CheckResult {
  return { id, layer, status: "pass", code: null, detail, credits };
}

export function failCheck(
  id: string,
  layer: 1 | 2,
  code: string,
  detail: string,
): CheckResult {
  return { id, layer, status: "fail", code, detail };
}

export function skipCheck(
  id: string,
  layer: 1 | 2,
  detail: string,
): CheckResult {
  return { id, layer, status: "not_applicable", code: null, detail };
}
