// Run lifecycle state machine (spec 07 §9-10). Persisted per run so the
// approval gate can pause a run and resume it later; the trace is the
// audit record, this is the working state.

import type { Store } from "./store";
import type { RunMode } from "./trace";

export const RUN_STEPS = [
  "ingested",
  "extracted",
  "matched",
  "decided",
  "awaiting_approval",
  "executed",
  "held",
  "rejected",
  "cost_capped",
  "iteration_capped",
  "error",
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

export const TERMINAL_STEPS: readonly RunStep[] = [
  "executed",
  "held",
  "rejected",
  "cost_capped",
  "iteration_capped",
  "error",
];

// Abort steps may be entered from any non-terminal step (breakers, errors).
const ABORT_STEPS: readonly RunStep[] = [
  "cost_capped",
  "iteration_capped",
  "error",
];

// Forward transitions (spec 07 §9). awaiting_approval -> decided is the
// single revision cycle: a rejection reason re-enters the loop exactly once
// (spec 10 §3); the machine enforces the cap.
const TRANSITIONS: Record<RunStep, readonly RunStep[]> = {
  ingested: ["extracted", "rejected"],
  extracted: ["matched", "held", "rejected"],
  matched: ["decided"],
  decided: ["awaiting_approval", "executed", "held", "rejected"],
  awaiting_approval: ["executed", "held", "rejected", "decided"],
  executed: [],
  held: [],
  rejected: [],
  cost_capped: [],
  iteration_capped: [],
  error: [],
};

export const MAX_REVISIONS = 1;
export const RUN_STATE_TTL_SECONDS = 24 * 60 * 60;

export interface RunStateRecord {
  run_id: string;
  step: RunStep;
  mode: RunMode;
  input_ref: string;
  revision_count: number;
  created_at: string;
  updated_at: string;
  // Working data accumulated along the way (extracted fields, match result,
  // decision, approval id). Shapes are owned by the writing stage.
  data: Record<string, unknown>;
}

const stateKey = (runId: string) => `runstate:${runId}`;

export class RunStateMachine {
  private constructor(
    private readonly store: Store,
    private record: RunStateRecord,
  ) {}

  static async create(
    store: Store,
    init: { run_id: string; mode: RunMode; input_ref: string },
  ): Promise<RunStateMachine> {
    const now = new Date().toISOString();
    const record: RunStateRecord = {
      run_id: init.run_id,
      step: "ingested",
      mode: init.mode,
      input_ref: init.input_ref,
      revision_count: 0,
      created_at: now,
      updated_at: now,
      data: {},
    };
    const machine = new RunStateMachine(store, record);
    await machine.persist();
    return machine;
  }

  static async load(
    store: Store,
    runId: string,
  ): Promise<RunStateMachine | null> {
    const raw = await store.get(stateKey(runId));
    if (!raw) return null;
    return new RunStateMachine(store, JSON.parse(raw) as RunStateRecord);
  }

  get state(): RunStateRecord {
    return structuredClone(this.record);
  }

  get isTerminal(): boolean {
    return TERMINAL_STEPS.includes(this.record.step);
  }

  private async persist(): Promise<void> {
    await this.store.set(
      stateKey(this.record.run_id),
      JSON.stringify(this.record),
      RUN_STATE_TTL_SECONDS,
    );
  }

  async transition(
    to: RunStep,
    patch: Record<string, unknown> = {},
  ): Promise<RunStateRecord> {
    const from = this.record.step;
    if (TERMINAL_STEPS.includes(from)) {
      throw new Error(`run ${this.record.run_id} is terminal at '${from}'`);
    }
    const allowed = TRANSITIONS[from].includes(to) || ABORT_STEPS.includes(to);
    if (!allowed) {
      throw new Error(`invalid transition ${from} -> ${to}`);
    }
    if (from === "awaiting_approval" && to === "decided") {
      if (this.record.revision_count >= MAX_REVISIONS) {
        throw new Error(
          `revision cap reached (${MAX_REVISIONS}); run must terminate`,
        );
      }
      this.record.revision_count += 1;
    }
    this.record.step = to;
    this.record.updated_at = new Date().toISOString();
    this.record.data = { ...this.record.data, ...patch };
    await this.persist();
    return this.state;
  }
}
