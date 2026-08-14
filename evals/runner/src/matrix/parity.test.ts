// Disposition-parity harness: real cases, real executors, guardrails, state
// machine and disposition, driven through the real batch driver, with the
// model replaced by a script. Key-free and free of spend.
//
// Two halves, and the second is the point:
//
//   Replay spread (1-4) walks sequences the golden set expects and asserts
//   each grades to its golden expectation. This guards the seam I integrated.
//
//   Adversarial scripts (5-7) walk sequences NO cassette contains, because a
//   cassette records the deterministic mock planner: it never re-drafts, never
//   resolves the wrong vendor first, and never writes a profile before
//   drafting. These three target the divergences the LOT-120 delta review
//   found, so they keep failing forever if those regress.
//
// 5-7 also pin the trace-ordering contract from the eval side: the graded
// decision must be the DISPOSED route while `model_route` keeps the model's
// proposal, which is the property whose inversion silently rewrites every
// decision in the matrix.

import type { ToolName } from "@novagait/agent";
import { describe, expect, it } from "vitest";
import { grade } from "../grade";
import { loadGoldenCases, type GoldenCase } from "../golden";
import { runLane } from "./batch";
import { SpendLedger } from "./ledger";
import { createMatrixPipeline } from "./live-pipeline";
import type { LivePipeline, LiveSession } from "./types";
import { VendorProfileStore, readTrace } from "@novagait/agent";
import {
  draftActionInput,
  extractionFor,
  scriptedBatchClient,
  toolTurn,
  type Script,
  type ScriptContext,
} from "./scripted-client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOLDEN_DIR = join(new URL("../../../golden", import.meta.url).pathname);
const LANE = { model: "claude-haiku-4-5", mode: "uncached" } as const;

let cached: GoldenCase[] | null = null;
async function golden(): Promise<GoldenCase[]> {
  cached ??= await loadGoldenCases(GOLDEN_DIR);
  return cached;
}

async function ledger(): Promise<SpendLedger> {
  const dir = await mkdtemp(join(tmpdir(), "lot105-parity-"));
  return SpendLedger.open(
    join(dir, "ledger.json"),
    () => "2026-08-11T00:00:00.000Z",
  );
}

/**
 * Runs one case through the driver with a scripted model.
 *
 * `seed` runs after the session is opened and before the lane starts, which
 * is the only window where a test can plant state the run will then read.
 */
async function runScripted(
  caseId: string,
  script: Script,
  seed?: (session: LiveSession) => Promise<void>,
) {
  const cases = await golden();
  const byId = new Map(cases.map((entry) => [entry.id, entry] as const));
  const goldenCase = byId.get(caseId);
  if (goldenCase === undefined) throw new Error(`unknown case ${caseId}`);

  const { pipeline, modelRoutes } = createMatrixPipeline({ goldenById: byId });
  const sessions: LiveSession[] = [];
  const observed: LivePipeline = {
    async openCase(entry, options) {
      const session = await pipeline.openCase(entry, options);
      await seed?.(session);
      sessions.push(session);
      return session;
    },
  };
  const { client } = scriptedBatchClient(script);
  const result = await runLane({
    lane: LANE,
    cases: [goldenCase],
    pipeline: observed,
    client,
    ledger: await ledger(),
    worstCasePerCaseUsd: 1,
    sleep: async () => {},
  });

  const outcome = result.outcomes[0];
  return {
    goldenCase,
    session: sessions[0],
    outcome,
    record: result.records[0],
    graded: grade(goldenCase, outcome),
    modelRoute: modelRoutes.get(result.records[0].run_id) ?? null,
  };
}

/** The draft_ref the run just minted; execute_action refuses any other. */
const draftRefFrom = (context: ScriptContext): string => {
  const drafts = (context.draft_action ?? []) as { draft_ref?: string }[];
  return drafts[drafts.length - 1]?.draft_ref ?? "MISSING";
};

const HAPPY = "inbox/2026-08-03-corvida-monthly.md";

/**
 * Builds a script from a golden case's own expected tool sequence.
 *
 * Data-driven rather than hand-written so the replay spread scales to any
 * case: the sequence comes from the golden file, and each input is derived
 * from the fixture's parsed extraction, which is what a competent model would
 * have produced. The drafted route is the case's expected decision, so the
 * script models a model that gets it right and leaves policy nothing to fix.
 */
function scriptFromGolden(goldenCase: GoldenCase) {
  const extraction = extractionFor(goldenCase.input.fixture);
  const inputs: Record<string, Record<string, unknown>> = {
    lookup_vendor: { name_raw: extraction.vendor_name_raw },
    lookup_po: { po_id: extraction.po_reference ?? "UNKNOWN" },
    lookup_receiving: { po_id: extraction.po_reference ?? "UNKNOWN" },
    check_duplicate: {
      vendor_id: extraction.vendor_id,
      invoice_number: extraction.invoice_number,
      content_digest: `digest-${goldenCase.id}`,
    },
    kb_search: { query: "tolerance for price variance" },
    update_vendor_profile: {
      vendor_id: extraction.vendor_id ?? "V-001",
      fields: { last_seen: extraction.invoice_date },
    },
  };
  return (goldenCase.expected.tool_calls as ToolName[]).map((name) =>
    name === "draft_action"
      ? toolTurn({
          name,
          input: draftActionInput({
            fixture: goldenCase.input.fixture,
            route: goldenCase.expected.decision,
            summary: `scripted ${goldenCase.expected.decision} for ${goldenCase.id}`,
          }),
        })
      : name === "execute_action"
        ? toolTurn({
            name,
            input: (context) => ({ draft_ref: draftRefFrom(context) }),
          })
        : toolTurn({ name, input: inputs[name] ?? {} }),
  );
}

/** First golden case carrying a tag, for tag-driven scenarios. */
async function caseWithTag(tag: string): Promise<GoldenCase> {
  const cases = await golden();
  const found = cases.find((entry) => entry.tags.includes(tag));
  if (found === undefined) throw new Error(`no golden case tagged ${tag}`);
  return found;
}

describe("parity: replay spread", () => {
  it("1. happy path grades to its golden expectation", async () => {
    const { graded, outcome } = await runScripted("INV-001", {
      "INV-001": [
        toolTurn({
          name: "lookup_vendor",
          input: { name_raw: "Corvida Billing Partners" },
        }),
        toolTurn({ name: "lookup_po", input: { po_id: "PO-2201" } }),
        toolTurn({
          name: "check_duplicate",
          input: {
            vendor_id: "V-001",
            invoice_number: "CB-2026-0803",
            content_digest: "digest-INV-001",
          },
        }),
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY,
            route: "auto_approve",
            summary:
              "Full period match against PO-2201, under the autonomy cap.",
            payment: {
              amount_cents: 43875,
              gl_code: "6120",
              pay_date: "2026-09-02",
            },
          }),
        }),
        // LOT-129 F1: approve/route goldens now require the execute_action
        // attempt, so a payable-route script that stops at the draft is a
        // graded failure (that is the under-call regression the requirement
        // exists to catch).
        toolTurn({
          name: "execute_action",
          input: (context) => ({ draft_ref: draftRefFrom(context) }),
        }),
      ],
    });

    expect(outcome.decision).toBe("auto_approve");
    expect(outcome.guardrails_fired).toEqual([]);
    expect(graded.pass).toBe(true);
  });

  it("2. a tolerance-edge case grades to its golden expectation", async () => {
    const toleranceCase = await caseWithTag("tolerance-edge");
    const { graded, outcome } = await runScripted(toleranceCase.id, {
      [toleranceCase.id]: scriptFromGolden(toleranceCase),
    });
    expect(outcome.decision).toBe(toleranceCase.expected.decision);
    expect(graded.pass).toBe(true);
  });

  it("4. a hard-floor case escalates and grades to its golden expectation", async () => {
    const floorCase = await caseWithTag("hard-floor");
    const { graded, outcome } = await runScripted(floorCase.id, {
      [floorCase.id]: scriptFromGolden(floorCase),
    });
    expect(outcome.decision).toBe(floorCase.expected.decision);
    expect(graded.pass).toBe(true);
  });

  it("3. duplicate holds, which only works because pre-seeding ran", async () => {
    const { outcome, graded } = await runScripted("INV-010", {
      "INV-010": [
        toolTurn({
          name: "lookup_vendor",
          input: { name_raw: "Corvida Billing Partners" },
        }),
        toolTurn({
          name: "check_duplicate",
          input: {
            vendor_id: "V-001",
            invoice_number: "CB-2026-0803",
            content_digest: "digest-INV-010",
          },
        }),
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY,
            route: "auto_approve",
            summary: "Looks like a clean match.",
          }),
        }),
      ],
    });

    // The model proposed approval; the duplicate guardrail is what stops it.
    // Without the pre-seeded INV-001 run there would be no ledger row to hit.
    expect(outcome.guardrails_fired).toContain("GR-DUP");
    expect(outcome.decision).not.toBe("auto_approve");
    expect(graded.pass).toBe(true);
  });
});

describe("parity: adversarial (sequences no cassette contains)", () => {
  it("5. a re-draft is what counts: state, gate and grading carry the SECOND draft", async () => {
    const { outcome, modelRoute } = await runScripted("INV-001", {
      "INV-001": [
        toolTurn({
          name: "lookup_vendor",
          input: { name_raw: "Corvida Billing Partners" },
        }),
        toolTurn({ name: "lookup_po", input: { po_id: "PO-2201" } }),
        // First draft carries a wrong total.
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY,
            route: "auto_approve",
            summary: "first pass, total misread",
            overrides: { total_cents: 999_99 },
          }),
        }),
        // Model reads the match result and corrects itself.
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY,
            route: "auto_approve",
            summary: "corrected against the PO",
          }),
        }),
      ],
    });

    // The graded extraction must be the second draft's, not the stale first.
    expect(outcome.fields.total_cents).toBe(43875);
    expect(outcome.drafted_action_text).toBe("corrected against the PO");
    expect(modelRoute).toBe("auto_approve");
  });

  it("6. a wrong first vendor does not latch: the GL comes from the RESOLVED vendor", async () => {
    // Armed on the reviewer's teeth-check. Asserting outcome.fields.vendor_id
    // proved nothing: re-resolution fixes the id whether or not the profile
    // latched, and no seeded vendor carries a learned_gl_code, so the latched
    // profile was null either way and the defect was unobservable.
    //
    // So plant a learned_gl_code on the WRONG vendor (Ferrowind, V-008) and
    // watch the money: a latched profile pays 7777, a correctly re-resolved
    // one pays Corvida's default 6100.
    const { outcome, session } = await runScripted(
      "INV-001",
      {
        "INV-001": [
          toolTurn({
            name: "lookup_vendor",
            input: { name_raw: "Ferrowind Construction Group" },
          }),
          toolTurn({
            name: "lookup_vendor",
            input: { name_raw: "Corvida Billing Partners" },
          }),
          toolTurn({ name: "lookup_po", input: { po_id: "PO-2201" } }),
          toolTurn({
            name: "check_duplicate",
            input: {
              vendor_id: "V-001",
              invoice_number: "CB-2026-0803",
              content_digest: "digest-INV-001-scenario6",
            },
          }),
          toolTurn({
            name: "draft_action",
            input: draftActionInput({
              fixture: HAPPY,
              route: "auto_approve",
              summary: "resolved to Corvida after a wrong first lookup",
              payment: {
                amount_cents: 43875,
                gl_code: "6100",
                pay_date: "2026-09-02",
              },
            }),
          }),
          toolTurn({
            name: "execute_action",
            input: (context) => ({ draft_ref: draftRefFrom(context) }),
          }),
        ],
      },
      async (session) => {
        await new VendorProfileStore(session.store).applyUpdate("V-008", {
          canonical_name: "Ferrowind Construction Group",
          learned_gl_code: "7777",
        });
      },
    );

    expect(outcome.fields.vendor_id).toBe("V-001");
    const payments = await session.backend.paymentSchedule();
    expect(payments.length).toBeGreaterThan(0);
    // The observable the latch defect would have corrupted.
    expect(payments[payments.length - 1].gl_code).toBe("6100");
    expect(payments[payments.length - 1].gl_code).not.toBe("7777");
  });

  it("7. a pre-draft profile write is REFUSED and cannot plant a GL code", async () => {
    // Armed on the reviewer's teeth-check. The old permissive guard accepted
    // this write because V-001 is a known vendor, and none of my assertions
    // looked at what the fix actually protects: the executed GL code. So
    // assert the refusal itself, and that the money used the default.
    const { outcome, graded, session } = await runScripted("INV-001", {
      "INV-001": [
        toolTurn({
          name: "update_vendor_profile",
          input: { vendor_id: "V-001", fields: { learned_gl_code: "9999" } },
        }),
        toolTurn({
          name: "lookup_vendor",
          input: { name_raw: "Corvida Billing Partners" },
        }),
        toolTurn({ name: "lookup_po", input: { po_id: "PO-2201" } }),
        toolTurn({
          name: "check_duplicate",
          input: {
            vendor_id: "V-001",
            invoice_number: "CB-2026-0803",
            content_digest: "digest-INV-001-scenario7",
          },
        }),
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY,
            route: "auto_approve",
            summary: "drafted after the premature profile write",
            payment: {
              amount_cents: 43875,
              gl_code: "6100",
              pay_date: "2026-09-02",
            },
          }),
        }),
        toolTurn({
          name: "execute_action",
          input: (context) => ({ draft_ref: draftRefFrom(context) }),
        }),
      ],
    });

    // 1. The write was refused, in those words.
    const events = await readTrace(session.store, session.runId);
    const write = events
      .filter(
        (event): event is Extract<typeof event, { type: "tool.call" }> =>
          event.type === "tool.call" && event.name === "update_vendor_profile",
      )
      .shift();
    expect(write?.result_summary).toMatch(/no resolved vendor yet/);

    // 2. The planted code never reached the money.
    const payments = await session.backend.paymentSchedule();
    expect(payments.length).toBeGreaterThan(0);
    expect(payments[payments.length - 1].gl_code).toBe("6100");
    expect(payments[payments.length - 1].gl_code).not.toBe("9999");

    expect(outcome.decision).toBe("auto_approve");
    expect(outcome.terminal_state).toBe("executed");
    expect(graded.pass).toBe(true);
  });

  it("control: a learned GL on the RESOLVED vendor DOES reach the payment", async () => {
    // Without this, scenarios 6 and 7 prove nothing. Both assert a NEGATIVE
    // (the wrong vendor's 7777 and the planted 9999 never reach the money),
    // and a negative is vacuous if the pipeline ignores learned GL codes
    // entirely. Seeding the CORRECT vendor and watching the payment change
    // shows the channel is live, so the negatives are real.
    const { session } = await runScripted(
      "INV-001",
      {
        "INV-001": [
          toolTurn({
            name: "lookup_vendor",
            input: { name_raw: "Corvida Billing Partners" },
          }),
          toolTurn({ name: "lookup_po", input: { po_id: "PO-2201" } }),
          toolTurn({
            name: "check_duplicate",
            input: {
              vendor_id: "V-001",
              invoice_number: "CB-2026-0803",
              content_digest: "digest-INV-001-control",
            },
          }),
          toolTurn({
            name: "draft_action",
            input: draftActionInput({
              fixture: HAPPY,
              route: "auto_approve",
              summary: "clean match with a learned GL on file",
              payment: {
                amount_cents: 43875,
                gl_code: "6100",
                pay_date: "2026-09-02",
              },
            }),
          }),
          toolTurn({
            name: "execute_action",
            input: (context) => ({ draft_ref: draftRefFrom(context) }),
          }),
        ],
      },
      async (session) => {
        await new VendorProfileStore(session.store).applyUpdate("V-001", {
          canonical_name: "Corvida Billing Partners",
          learned_gl_code: "7123",
        });
      },
    );

    const payments = await session.backend.paymentSchedule();
    expect(payments.length).toBeGreaterThan(0);
    // Learned code wins over the 6100 default, so the channel scenarios 6
    // and 7 assert against is demonstrably live.
    expect(payments[payments.length - 1].gl_code).toBe("7123");
  });

  it("pins the ordering contract: graded decision is the DISPOSED route", async () => {
    // A hard-floor case: the model proposes approval, policy must escalate.
    const cases = await golden();
    const floorCase = cases.find(
      (entry) =>
        entry.tags.includes("hard-floor") &&
        entry.expected.decision !== "auto_approve",
    );
    expect(floorCase).toBeDefined();

    const { outcome, modelRoute } = await runScripted(floorCase!.id, {
      [floorCase!.id]: [
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: floorCase!.input.fixture,
            route: "auto_approve",
            summary: "model wants to approve this outright",
          }),
        }),
      ],
    });

    // This is the assertion whose inversion silently rewrites the matrix.
    expect(modelRoute).toBe("auto_approve");
    expect(outcome.decision).not.toBe("auto_approve");
    expect(outcome.decision).toBe(floorCase!.expected.decision);
  });
});
