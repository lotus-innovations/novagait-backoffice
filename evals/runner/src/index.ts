// Package surface. The eval harness is the product: golden dataset (LOT-90),
// graders + taxonomy + thresholds (LOT-96); cassettes + CI gate land in
// LOT-106 and extend this list.
export const EVALS_RUNNER_PACKAGE = "@novagait/evals-runner";

export * from "./golden";
export * from "./outcome";
export * from "./normalize";
export * from "./taxonomy";
export * from "./graders/types";
export * from "./graders/deterministic";
export * from "./graders/fuzzy";
export * from "./graders/judge";
export * from "./grade";
export * from "./summary";
export * from "./thresholds";
