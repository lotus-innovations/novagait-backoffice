// Adapter from LOT-120's createLivePipeline to the matrix driver's session
// seam (types.ts). The factory owns everything product-side: a store per
// case, ERP seeding, pre-seed predecessors, run.start, the disposition, and
// run.end. This file supplies the two things the product cannot know, and
// nothing else:
//
//   1. `toOutcome`, the projection into the graded view. Lifted from
//      cassettes/record.ts runOne so "live results and cassettes are graded
//      by identical code" is literally true rather than nearly true.
//   2. `resolveCase`, so pre-seeding can find INV-001 when opening INV-010.
//
// Tool-call tracing is NOT here any more: the product exports
// `traceToolCalls` (live-agent.ts), which binds the run and delegates to the
// same wrapper runWorkflow uses, so the batched and interactive lanes share
// one implementation rather than two copies that can drift. That drift was a
// live blocker; see ASSUMPTIONS.md A9.

import {
  RunStateMachine,
  extractionSchema,
  readTrace,
  type Store,
  type TraceEvent,
} from "@novagait/agent";
import type { MockBackend } from "@novagait/mock-backend";
import {
  createLivePipeline as createProductPipeline,
  traceToolCalls,
  type LiveCaseSession,
} from "@novagait/pipeline";
import type { GoldenCase } from "../golden";
import { fromTraceEvents, type RunOutcome } from "../outcome";
import type { LivePipeline, LiveSession, OpenCaseOptions } from "./types";

export interface LiveOutcomeContext {
  runId: string;
  store: Store;
  backend: MockBackend;
  route: string | null;
  outcome: string;
}

/**
 * The cassette recorder's projection, applied to a live run.
 *
 * Kept structurally identical to cassettes/record.ts runOne: trace events for
 * behaviour, run state for the extraction (the trace carries only
 * {route, summary, model_route} on draft_action), the GR-SCOPE reject treated
 * as schema-satisfied rather than schema-failed, and the pipeline's route as
 * the decision of last resort when no draft_action was ever written.
 */
export async function projectLiveOutcome(
  context: LiveOutcomeContext,
  caseId: string,
): Promise<RunOutcome> {
  const events = await readTrace(context.store, context.runId);
  const machine = await RunStateMachine.load(context.store, context.runId);
  const rawExtraction = machine?.state.data.extraction;
  const parsed =
    rawExtraction === undefined
      ? null
      : extractionSchema.safeParse(rawExtraction);

  const outcome = fromTraceEvents(events, {
    case_id: caseId,
    fields: parsed?.success
      ? {
          vendor_id: parsed.data.vendor_id,
          vendor_name_raw: parsed.data.vendor_name_raw,
          invoice_number: parsed.data.invoice_number,
          invoice_date: parsed.data.invoice_date,
          due_date: parsed.data.due_date,
          total_cents: parsed.data.total_cents,
          currency: parsed.data.currency,
          po_reference: parsed.data.po_reference,
        }
      : {},
    output_schema_valid: parsed ? parsed.success : context.route === "reject",
  });

  return {
    ...outcome,
    decision:
      outcome.decision ?? (context.route as RunOutcome["decision"] | null),
  };
}

/**
 * The model's own proposed route, before policy disposed of it.
 *
 * traceArgs keeps it on draft_action as `model_route` precisely so the two
 * can be compared; the graded decision is always the disposed one. Published
 * as a divergence column on /eval ("model proposed, policy disposed").
 */
export function modelRouteFrom(events: TraceEvent[]): string | null {
  const draft = [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter(
      (event): event is Extract<TraceEvent, { type: "tool.call" }> =>
        event.type === "tool.call" && event.name === "draft_action",
    )
    .pop();
  const raw = draft?.args.model_route;
  return typeof raw === "string" ? raw : null;
}

export interface MatrixPipeline {
  pipeline: LivePipeline;
  /** Model-proposed route per run id, for the divergence column. */
  modelRoutes: Map<string, string | null>;
}

export interface MatrixPipelineOptions {
  goldenById: Map<string, GoldenCase>;
  seedFixtures?: boolean;
}

export function createMatrixPipeline(
  options: MatrixPipelineOptions,
): MatrixPipeline {
  const modelRoutes = new Map<string, string | null>();
  const caseIdByRun = new Map<string, string>();

  const product = createProductPipeline<RunOutcome>({
    seedFixtures: options.seedFixtures,
    resolveCase: (caseId) => options.goldenById.get(caseId),
    toOutcome: async (context) => {
      const caseId = caseIdByRun.get(context.runId) ?? "";
      const projected = await projectLiveOutcome(
        context as LiveOutcomeContext,
        caseId,
      );
      modelRoutes.set(
        context.runId,
        modelRouteFrom(await readTrace(context.store, context.runId)),
      );
      return projected;
    },
  });

  const pipeline: LivePipeline = {
    async openCase(
      goldenCase: GoldenCase,
      opts: OpenCaseOptions,
    ): Promise<LiveSession> {
      const session: LiveCaseSession<RunOutcome> = await product.openCase(
        goldenCase,
        { mode: opts.mode, model: opts.model },
      );
      caseIdByRun.set(session.runId, goldenCase.id);

      let iteration = 0;
      let pending: {
        totals: Record<string, number>;
        iterations: number;
        terminal?: { outcome: string; failure_code: string | null };
      } | null = null;

      return {
        runId: session.runId,
        store: session.store,
        backend: session.backend,
        userMessage: session.userMessage,
        // GR-SCOPE runs are born closed: the executors refuse work after
        // run.end, so a lane that ignored this would pay for a request the
        // run cannot use and corrupt the case it grades.
        shortCircuit: session.shortCircuited,
        // The product's wrapper, bound to the whole run. It projects from the
        // executor's own OUTPUT, so the ordering my mirror inverted is now
        // impossible to get wrong, and it refuses to trace a short-circuited
        // run so nothing can append after run.end.
        executors: traceToolCalls(session, () => iteration),
        setIteration(next: number) {
          iteration = next;
        },
        async start() {
          // The factory writes run.start when it opens the case.
        },
        async finish(args) {
          pending = {
            totals: { ...args.totals },
            iterations: args.iterations,
            terminal: args.terminal,
          };
        },
        async toOutcome(): Promise<RunOutcome> {
          // One call for both paths now: `terminal` tells the session the
          // driver's breaker ended the run, so it settles the machine on the
          // abort step, writes the single run.end, and disposes nothing.
          const projected = await session.toOutcome(
            {
              ...(pending?.totals ?? {}),
              iteration_count: pending?.iterations,
            },
            pending?.terminal as Parameters<typeof session.toOutcome>[1],
          );
          modelRoutes.set(
            session.runId,
            modelRouteFrom(await readTrace(session.store, session.runId)),
          );
          return projected;
        },
      };
    },
  };

  return { pipeline, modelRoutes };
}
