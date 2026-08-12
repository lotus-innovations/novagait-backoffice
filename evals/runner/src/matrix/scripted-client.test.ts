// Transport-only tests for the scripted client. Deliberately makes no claim
// about how the live surface disposes anything: this proves the harness can
// say what we need it to say, so that when the parity assertions land they
// are testing the product rather than the fake.

import { describe, expect, it } from "vitest";
import {
  draftActionInput,
  endTurn,
  extractionFor,
  scriptedBatchClient,
  toolTurn,
} from "./scripted-client";

const HAPPY_FIXTURE = "inbox/2026-08-03-corvida-monthly.md";

async function drain(
  client: ReturnType<typeof scriptedBatchClient>["client"],
  ids: string[],
): Promise<Record<string, unknown>[]> {
  const { id } = await client.create(
    ids.map((custom_id) => ({ custom_id, params: {} })),
  );
  const rows: Record<string, unknown>[] = [];
  for await (const row of client.results(id)) {
    rows.push(row as unknown as Record<string, unknown>);
  }
  return rows;
}

describe("scriptedBatchClient", () => {
  it("emits scripted tool calls, then ends when the script runs out", async () => {
    const { client } = scriptedBatchClient({
      "INV-001": [
        toolTurn({ name: "lookup_vendor", input: { name_raw: "Corvida" } }),
      ],
    });

    const first = await drain(client, ["INV-001"]);
    const firstMessage = (
      first[0] as {
        result: {
          message: {
            stop_reason: string;
            content: { type: string; name?: string }[];
          };
        };
      }
    ).result.message;
    expect(firstMessage.stop_reason).toBe("tool_use");
    expect(firstMessage.content[0].name).toBe("lookup_vendor");

    const second = await drain(client, ["INV-001"]);
    const secondMessage = (
      second[0] as { result: { message: { stop_reason: string } } }
    ).result.message;
    expect(secondMessage.stop_reason).toBe("end_turn");
  });

  it("can emit the same tool twice across turns, which cassettes never do", async () => {
    const { client, spy } = scriptedBatchClient({
      "INV-001": [
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY_FIXTURE,
            route: "auto_approve",
            summary: "first draft",
          }),
        }),
        toolTurn({
          name: "draft_action",
          input: draftActionInput({
            fixture: HAPPY_FIXTURE,
            route: "auto_approve",
            summary: "second draft",
            overrides: { total_cents: 999_99 },
          }),
        }),
        endTurn(),
      ],
    });

    const turns: string[] = [];
    for (let round = 0; round < 3; round++) {
      const rows = await drain(client, ["INV-001"]);
      const message = (
        rows[0] as {
          result: {
            message: {
              content: { type: string; input?: { summary?: string } }[];
            };
          };
        }
      ).result.message;
      const draft = message.content.find((block) => block.type === "tool_use");
      if (draft?.input?.summary) turns.push(draft.input.summary);
    }

    expect(turns).toEqual(["first draft", "second draft"]);
    expect(spy.rounds).toHaveLength(3);
  });

  it("builds a draft_action input from the real parsed extraction", () => {
    const input = draftActionInput({
      fixture: HAPPY_FIXTURE,
      route: "auto_approve",
      summary: "clean match",
    });
    const extraction = input.extraction as Record<string, unknown>;
    expect(extraction.invoice_number).toBe(
      extractionFor(HAPPY_FIXTURE).invoice_number,
    );
    expect(input.route).toBe("auto_approve");
    expect(input.payment).toBeNull();
  });

  it("lets a test express a wrong value without hand-writing an extraction", () => {
    const input = draftActionInput({
      fixture: HAPPY_FIXTURE,
      route: "auto_approve",
      summary: "wrong total",
      overrides: { total_cents: 1 },
    });
    const extraction = input.extraction as Record<string, unknown>;
    expect(extraction.total_cents).toBe(1);
    // Everything else still comes from the fixture.
    expect(extraction.vendor_id).toBe(extractionFor(HAPPY_FIXTURE).vendor_id);
  });

  it("records what was submitted each round so a test can assert fan-out", async () => {
    const { client, spy } = scriptedBatchClient({});
    await drain(client, ["INV-001", "INV-002"]);
    await drain(client, ["INV-002"]);
    expect(spy.rounds).toEqual([["INV-001", "INV-002"], ["INV-002"]]);
    expect(spy.batches).toEqual(["scripted_0", "scripted_1"]);
  });
});
