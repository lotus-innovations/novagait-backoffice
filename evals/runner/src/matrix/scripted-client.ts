// A BatchClient that emits scripted model turns instead of calling the API.
//
// This is the transport half of the disposition-parity harness. It exists
// because cassette replay alone cannot reproduce the interesting bugs: a
// cassette records the deterministic mock planner, which never re-drafts,
// never resolves the wrong vendor first, and never writes a vendor profile
// before drafting. A scripted client can emit ANY sequence, including the
// sequences a real model produces on a bad day.
//
// Behaviour-free on purpose. Nothing here asserts what the live surface
// should do; it only decides what the "model" says next. The assertions live
// in the parity tests, so this file cannot encode a bug as expected.
//
// Key-free by construction: no client, no key, no network, no spend.

import { FIXTURES, VENDORS } from "@novagait/mock-backend";
import { parseFixture } from "@novagait/pipeline";
import type { ToolName } from "@novagait/agent";
import type { BatchClient, BatchResultRow, BatchRequest } from "./batch";

/**
 * Prior tool results for this case, keyed by the tool that produced them, in
 * call order. A script needs these because some inputs are only knowable at
 * run time: `execute_action` must quote the `draft_ref` that `draft_action`
 * just minted, and the live surface refuses any other value.
 */
export type ScriptContext = Record<string, unknown[]>;

export interface ScriptedToolCall {
  name: ToolName;
  /** Static input, or one computed from what the run has returned so far. */
  input:
    | Record<string, unknown>
    | ((context: ScriptContext) => Record<string, unknown>);
}

export interface ScriptedTurn {
  /** Tool calls for this turn; empty or omitted ends the run. */
  tools?: ScriptedToolCall[];
  text?: string;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }>;
}

/** One entry per case: the turns that case's "model" produces, in order. */
export type Script = Record<string, ScriptedTurn[]>;

export interface ScriptedClientSpy {
  batches: string[];
  /** custom_ids submitted per round, in submission order. */
  rounds: string[][];
  requests: BatchRequest[][];
}

const DEFAULT_USAGE = {
  input_tokens: 1_000,
  output_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * Turns a script into a BatchClient.
 *
 * A case with no scripted turn left simply ends its run, which is what a
 * finished agent does, so a script only has to describe the interesting part.
 */
export function scriptedBatchClient(
  script: Script,
  spy: ScriptedClientSpy = { batches: [], rounds: [], requests: [] },
): { client: BatchClient; spy: ScriptedClientSpy } {
  let round = -1;
  let active: string[] = [];

  const client: BatchClient = {
    async create(requests) {
      round += 1;
      active = requests.map((request) => request.custom_id);
      spy.batches.push(`scripted_${round}`);
      spy.rounds.push([...active]);
      spy.requests.push(requests);
      return { id: `scripted_${round}` };
    },
    async retrieve() {
      return { processing_status: "ended" };
    },
    async cancel() {
      // Scripted batches never stall, so cancellation is unreachable here.
    },
    async *results(batchId): AsyncIterable<BatchResultRow> {
      const index = Number(batchId.split("_")[1]);
      const submitted = spy.requests[index] ?? [];
      for (const customId of active) {
        const turn = script[customId]?.[index];
        const tools = turn?.tools ?? [];
        const context = contextFrom(
          submitted.find((request) => request.custom_id === customId),
        );
        const content = [
          ...(turn?.text ? [{ type: "text", text: turn.text }] : []),
          ...tools.map((call, position) => ({
            type: "tool_use",
            id: `toolu_${customId}_${index}_${position}`,
            name: call.name,
            input:
              typeof call.input === "function"
                ? call.input(context)
                : call.input,
          })),
        ];
        yield {
          custom_id: customId,
          result: {
            type: "succeeded",
            message: {
              id: `msg_${customId}_${index}`,
              content:
                content.length > 0 ? content : [{ type: "text", text: "done" }],
              stop_reason: tools.length > 0 ? "tool_use" : "end_turn",
              usage: { ...DEFAULT_USAGE, ...(turn?.usage ?? {}) },
            },
          },
        } as unknown as BatchResultRow;
      }
    },
  };

  return { client, spy };
}

/**
 * Reconstructs what the run has returned so far from the request itself.
 *
 * The driver resends the whole conversation each round, so the submitted
 * messages carry every tool_use and its tool_result; pairing them by id
 * recovers the results without the client having to hold state.
 */
function contextFrom(request?: BatchRequest): ScriptContext {
  const context: ScriptContext = {};
  const nameById = new Map<string, string>();
  const messages = (request?.params.messages ?? []) as {
    role: string;
    content?: unknown;
  }[];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "tool_use") {
        nameById.set(String(block.id), String(block.name));
      }
      if (block.type === "tool_result") {
        const name = nameById.get(String(block.tool_use_id));
        if (name === undefined) continue;
        let parsed: unknown = block.content;
        try {
          parsed = JSON.parse(String(block.content));
        } catch {
          // Non-JSON tool output (a refusal string) is passed through as-is.
        }
        context[name] = [...(context[name] ?? []), parsed];
      }
    }
  }
  return context;
}

/**
 * A schema-valid `draft_action` input built from a real fixture.
 *
 * The extraction is parsed from the fixture rather than hand-written so the
 * drafted values are the ones a competent model would actually produce;
 * `overrides` is how a test expresses "the model got this field wrong", which
 * is the whole point of the re-draft scenario.
 */
export function draftActionInput(args: {
  fixture: string;
  route: string;
  summary: string;
  overrides?: Record<string, unknown>;
  payment?: Record<string, unknown> | null;
  vendorEmailDraft?: string | null;
}): Record<string, unknown> {
  const documentText = FIXTURES[args.fixture];
  if (documentText === undefined) {
    throw new Error(`scripted-client: unknown fixture ${args.fixture}`);
  }
  const extraction = {
    ...parseFixture(documentText, VENDORS),
    ...(args.overrides ?? {}),
  };
  return {
    route: args.route,
    extraction,
    summary: args.summary,
    policy_line: args.summary,
    payment: args.payment ?? null,
    vendor_email_draft: args.vendorEmailDraft ?? null,
  };
}

/** The extraction a fixture parses to, for building expectations. */
export function extractionFor(
  fixture: string,
): ReturnType<typeof parseFixture> {
  const documentText = FIXTURES[fixture];
  if (documentText === undefined) {
    throw new Error(`scripted-client: unknown fixture ${fixture}`);
  }
  return parseFixture(documentText, VENDORS);
}

export const toolTurn = (...tools: ScriptedToolCall[]): ScriptedTurn => ({
  tools,
});

export const endTurn = (text = "done"): ScriptedTurn => ({ text });
