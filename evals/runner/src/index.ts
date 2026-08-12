// Package surface. The eval harness is the product: golden dataset (LOT-90),
// graders + taxonomy + thresholds (LOT-96); replay cassettes + the CI gate
// (LOT-106).
export const EVALS_RUNNER_PACKAGE = "@novagait/evals-runner";

export * from "./golden";
export * from "./live-lane";
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
export * from "./cassettes/cassette";
export * from "./cassettes/paths";
export * from "./cassettes/record";
export * from "./cassettes/replay";
export * from "./cassettes/baseline";
export * from "./cassettes/drift";
