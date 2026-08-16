import Link from "next/link";
import { notFound } from "next/navigation";
import { getApprovalForRun } from "@novagait/agent";
import { formatMicroUsd, getRunSummary, getRunTrace } from "@/lib/runs";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = getStore();
  const summary = await getRunSummary(store, id);
  const events = await getRunTrace(store, id);
  if (!summary && events.length === 0) notFound();
  const approval =
    summary?.outcome === "awaiting_approval"
      ? await getApprovalForRun(store, id)
      : null;

  return (
    <main>
      <h1>
        Run <code>{id}</code>
      </h1>
      {summary && (
        <table>
          <tbody>
            <tr>
              <th scope="row">Document</th>
              <td>{summary.input_ref}</td>
              <th scope="row">Mode</th>
              <td>{summary.mode}</td>
            </tr>
            <tr>
              <th scope="row">Model</th>
              <td>{summary.model}</td>
              <th scope="row">Outcome</th>
              <td>
                <span className={`outcome-${summary.outcome ?? "running"}`}>
                  {summary.outcome ?? "running"}
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">Total cost</th>
              <td>{formatMicroUsd(summary.total_cost_micro_usd)}</td>
              <th scope="row">Iterations</th>
              <td>{summary.iteration_count ?? "-"}</td>
            </tr>
          </tbody>
        </table>
      )}
      {approval?.status === "pending" ? (
        <p role="status" className="banner" data-tour="approval-banner">
          This run is paused at the approval gate.{" "}
          <Link href={`/approvals/${approval.approval_id}`}>
            Review and decide
          </Link>
          .
        </p>
      ) : null}
      <p>
        <a href={`/api/runs/${id}/trace.jsonl`}>
          Download the full trace (jsonl)
        </a>{" "}
        - one event per line, exactly as stored.
      </p>
      <h2>Timeline ({events.length} events)</h2>
      <ol style={{ listStyle: "none", padding: 0 }} data-tour="run-timeline">
        {events.map((event) => (
          <li key={event.seq}>
            <details className="event">
              <summary>
                #{event.seq} {event.type} <code>{event.node_id}</code>{" "}
                {"cost_micro_usd" in event
                  ? `(${formatMicroUsd(event.cost_micro_usd)})`
                  : ""}
                {"verdict" in event ? `verdict: ${event.verdict}` : ""}
              </summary>
              <pre>{JSON.stringify(event, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </main>
  );
}
