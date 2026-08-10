import Link from "next/link";
import { formatMicroUsd, listRecentRuns } from "@/lib/runs";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRecentRuns(getStore());

  return (
    <main>
      <h1>Runs</h1>
      <p>
        Every run is fully audited: each model call, tool call, guardrail check,
        approval event, and backend write appears in its trace with a
        correlation id (<code>run_id</code> / <code>node_id</code>) and a
        measured cost.
      </p>
      {runs.length === 0 ? (
        <div className="empty">
          <p>
            No runs yet. A run is one document processed end to end: intake,
            extraction, 3-way match, decision, approval gate, execution. Data
            resets nightly; nothing here is worth keeping.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Document</th>
              <th scope="col">Mode</th>
              <th scope="col">Model</th>
              <th scope="col">Outcome</th>
              <th scope="col">Cost</th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.run_id}>
                <td>
                  <Link href={`/runs/${run.run_id}`}>
                    <code>{run.run_id.slice(-8)}</code>
                  </Link>
                </td>
                <td>{run.input_ref}</td>
                <td>{run.mode}</td>
                <td>{run.model}</td>
                <td>
                  <span className={`outcome-${run.outcome ?? "running"}`}>
                    {run.outcome ?? "running"}
                  </span>
                </td>
                <td>{formatMicroUsd(run.total_cost_micro_usd)}</td>
                <td>{run.started_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
