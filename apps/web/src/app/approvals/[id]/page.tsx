import Link from "next/link";
import { notFound } from "next/navigation";
import {
  RunStateMachine,
  getApproval,
  type ExtractedInvoice,
} from "@novagait/agent";
import type { DraftExecution } from "@novagait/pipeline";
import { getRunTrace } from "@/lib/runs";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface MatchResult {
  matched: boolean;
  exceptions: string[];
}

// The approver experience (spec 12 §1, design brief F): the drafted action,
// the evidence that produced it, and three decisions. This screen is the
// human-in-the-loop gate at the material decision point; the gate itself is
// code (GR-EXEC), so nothing executes until a decision lands here.
export default async function ApprovalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = getStore();
  const approval = await getApproval(store, id);
  if (!approval) notFound();
  const machine = await RunStateMachine.load(store, approval.run_id);
  if (!machine) notFound();

  const data = machine.state.data;
  const extraction = data.extraction as ExtractedInvoice | undefined;
  const match = data.match as MatchResult | undefined;
  const execution = data.execution as DraftExecution | null | undefined;
  const policyLine = String(data.policy_line ?? "");
  const visitorNote =
    typeof data.visitor_note === "string" ? data.visitor_note : null;

  const events = await getRunTrace(store, approval.run_id);
  const requested = events.find((event) => event.type === "approval.requested");
  const whyHuman =
    requested && "policy_line" in requested ? requested.policy_line : null;

  const pending = approval.status === "pending";

  return (
    <main>
      <h1>
        Approval <code>{approval.approval_id.slice(-8)}</code>
      </h1>
      <p>
        Run{" "}
        <Link href={`/runs/${approval.run_id}`}>
          <code>{approval.run_id.slice(-8)}</code>
        </Link>{" "}
        drafted an action and stopped. The execution tool checked mode and
        policy in code and refused to proceed without you; approving here is the
        only way it executes.
      </p>

      {!pending ? (
        <p role="status" className="banner">
          Decided: <strong>{approval.status}</strong> by{" "}
          <code>{approval.actor}</code> ({approval.reason}). See the{" "}
          <Link href={`/runs/${approval.run_id}`}>run timeline</Link>.
        </p>
      ) : null}

      <section aria-labelledby="draft-h">
        <h2 id="draft-h">Drafted action</h2>
        <table>
          <tbody>
            <tr>
              <th scope="row">Route</th>
              <td>{approval.route}</td>
              <th scope="row">Draft</th>
              <td>
                <code>{approval.draft_ref}</code>
              </td>
            </tr>
            {execution ? (
              <tr>
                <th scope="row">Payment</th>
                <td>
                  {usd(execution.total_cents)} to{" "}
                  <code>{execution.vendor_id}</code>
                </td>
                <th scope="row">GL / pay date</th>
                <td>
                  {execution.gl_code} on {execution.pay_date}
                </td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Policy line</th>
              <td colSpan={3}>{policyLine}</td>
            </tr>
            {whyHuman ? (
              <tr>
                <th scope="row">Why a human</th>
                <td colSpan={3}>{whyHuman}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {extraction ? (
        <section aria-labelledby="evidence-h">
          <h2 id="evidence-h">Evidence: extracted fields</h2>
          <p>
            Every extracted value carries the verbatim quote it came from, so
            you are checking the document, not trusting the agent.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">As printed on the document</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["vendor", extraction.vendor_name_raw, "vendor_name_raw"],
                  [
                    "invoice_number",
                    extraction.invoice_number,
                    "invoice_number",
                  ],
                  ["invoice_date", extraction.invoice_date, "invoice_date"],
                  ["due_date", extraction.due_date ?? "-", "due_date"],
                  ["total", usd(extraction.total_cents), "total_cents"],
                  [
                    "po_reference",
                    extraction.po_reference ?? "-",
                    "po_reference",
                  ],
                ] as Array<[string, string, string]>
              ).map(([field, value, spanKey]) => (
                <tr key={field}>
                  <td>{field}</td>
                  <td>{value}</td>
                  <td>
                    {extraction.source_spans[spanKey] ? (
                      <q>{extraction.source_spans[spanKey]}</q>
                    ) : (
                      <span className="muted">no span recorded</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Line items</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">Qty</th>
                <th scope="col">Unit</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {extraction.line_items.map((line, index) => (
                <tr key={index}>
                  <td>{line.description}</td>
                  <td>{line.qty}</td>
                  <td>{usd(line.unit_price_cents)}</td>
                  <td>{usd(line.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {match ? (
            <p>
              3-way match:{" "}
              {match.matched ? (
                <span className="outcome-executed">full match</span>
              ) : (
                <span className="outcome-held">
                  exceptions: {match.exceptions.join(", ")}
                </span>
              )}
            </p>
          ) : null}
          {visitorNote ? (
            <p>
              Intake note (untrusted, screened): <q>{visitorNote}</q>
            </p>
          ) : null}
        </section>
      ) : null}

      {pending ? (
        <section aria-labelledby="decide-h">
          <h2 id="decide-h">Your decision</h2>
          <form method="post" action={`/api/approvals/${approval.approval_id}`}>
            <input type="hidden" name="decision" value="approve" />
            <p>
              <label htmlFor="approve-reason">Reason (optional)</label>{" "}
              <input
                id="approve-reason"
                name="reason"
                type="text"
                size={40}
                placeholder="looks right"
              />{" "}
              <button type="submit">Approve</button>
            </p>
          </form>

          <form method="post" action={`/api/approvals/${approval.approval_id}`}>
            <input type="hidden" name="decision" value="edit_approve" />
            <fieldset>
              <legend>Edit, then approve</legend>
              <p>
                <label htmlFor="edit-gl">GL code</label>{" "}
                <input
                  id="edit-gl"
                  name="gl_code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{4}"
                  size={6}
                  defaultValue={execution?.gl_code}
                />{" "}
                <label htmlFor="edit-date">Pay date</label>{" "}
                <input
                  id="edit-date"
                  name="pay_date"
                  type="date"
                  defaultValue={execution?.pay_date}
                />
              </p>
              <p>
                <label htmlFor="edit-reason">Reason</label>{" "}
                <input
                  id="edit-reason"
                  name="reason"
                  type="text"
                  size={40}
                  required
                  placeholder="e.g. recode to equipment leasing"
                />{" "}
                <button type="submit">Approve with edits</button>
              </p>
            </fieldset>
          </form>

          <form method="post" action={`/api/approvals/${approval.approval_id}`}>
            <input type="hidden" name="decision" value="reject" />
            <p>
              <label htmlFor="reject-reason">Rejection reason (required)</label>{" "}
              <input
                id="reject-reason"
                name="reason"
                type="text"
                size={40}
                required
                placeholder="e.g. wrong PO, hold for review"
              />{" "}
              <button type="submit">Reject</button>
            </p>
          </form>
        </section>
      ) : null}
    </main>
  );
}
