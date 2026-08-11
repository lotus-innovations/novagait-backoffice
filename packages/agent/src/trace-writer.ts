// Trace writer (spec 08 §5): append-only per-run event list, run summary
// hash, capped recent-runs index. Redaction happens here (write boundary)
// and nowhere else. 24h TTL on everything; the nightly reset reseeds anyway.

import { redactToolArgs } from "./redact";
import type { Store } from "./store";
import {
  TRACE_SCHEMA_VERSION,
  validateTraceEvent,
  type TraceEvent,
  type TraceEventInput,
} from "./trace";
import { ulid } from "./ulid";

export const TRACE_TTL_SECONDS = 24 * 60 * 60;
export const RECENT_RUNS_CAP = 200;

export const traceKeys = {
  trace: (runId: string) => `trace:${runId}`,
  run: (runId: string) => `run:${runId}`,
  recent: () => "runs:recent",
} as const;

export class TraceWriter {
  private seq = 0;
  readonly runId: string;
  // When set, echoed onto every event (LOT-102, optional EventBase.mode).
  mode?: TraceEvent["mode"];

  constructor(
    private readonly store: Store,
    runId?: string,
    mode?: TraceEvent["mode"],
  ) {
    this.runId = runId ?? ulid();
    this.mode = mode;
  }

  /**
   * Continue an existing run's trace (approval resume, LOT-104): seq picks
   * up after the recorded events, so a resumed run appends a second
   * approval/execution segment and a final run.end. The parked segment's
   * run.end{outcome:"awaiting_approval"} stays in the list by design; the
   * run summary hash is overwritten by the final run.end.
   */
  static async resume(store: Store, runId: string): Promise<TraceWriter> {
    const events = await store.listRange(traceKeys.trace(runId), 0, -1);
    const writer = new TraceWriter(store, runId);
    writer.seq = events.length;
    return writer;
  }

  private stamp(input: TraceEventInput): TraceEvent {
    const event = {
      ...input,
      run_id: this.runId,
      ts: new Date().toISOString(),
      seq: this.seq++,
      trace_schema_version: TRACE_SCHEMA_VERSION,
      ...(this.mode ? { mode: this.mode } : {}),
    } as TraceEvent;
    if (event.type === "tool.call") {
      event.args = redactToolArgs(event.args);
    }
    return event;
  }

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const event = this.stamp(input);
    const validation = validateTraceEvent(event);
    if (!validation.valid) {
      throw new Error(`invalid trace event: ${validation.errors.join("; ")}`);
    }
    const key = traceKeys.trace(this.runId);
    await this.store.listPush(key, JSON.stringify(event));
    await this.store.expire(key, TRACE_TTL_SECONDS);

    if (event.type === "run.start") {
      await this.store.hset(traceKeys.run(this.runId), {
        run_id: this.runId,
        mode: event.mode,
        model: event.model,
        input_ref: event.input_ref,
        started_at: event.ts,
      });
      await this.store.expire(traceKeys.run(this.runId), TRACE_TTL_SECONDS);
      const count = await this.store.listPush(traceKeys.recent(), this.runId);
      if (count > RECENT_RUNS_CAP) {
        await this.store.listTrim(
          traceKeys.recent(),
          count - RECENT_RUNS_CAP,
          -1,
        );
      }
    }

    if (event.type === "run.end") {
      await this.store.hset(traceKeys.run(this.runId), {
        outcome: event.outcome,
        total_cost_micro_usd: String(event.total_cost_micro_usd),
        iteration_count: String(event.iteration_count),
        ended_at: event.ts,
      });
      await this.store.expire(traceKeys.run(this.runId), TRACE_TTL_SECONDS);
    }

    return event;
  }
}

export async function readTrace(
  store: Store,
  runId: string,
): Promise<TraceEvent[]> {
  const raw = await store.listRange(traceKeys.trace(runId), 0, -1);
  return raw.map((line) => JSON.parse(line) as TraceEvent);
}

export function toJsonl(events: TraceEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}
