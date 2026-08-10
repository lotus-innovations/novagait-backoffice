import Link from "next/link";
import {
  listDedupeEntries,
  listRunStates,
  listVendorProfiles,
} from "@/lib/memory-views";
import { getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// The inspectability beat (arch doc E): agent memory is three named,
// bounded, schema'd stores you can read as plain tables, not an opaque
// vector index. Every row links back to the runs that touched it.
export default async function MemoryPage() {
  const store = getStore();
  const [runStates, profiles, dedupe] = await Promise.all([
    listRunStates(store),
    listVendorProfiles(store),
    listDedupeEntries(store),
  ]);

  return (
    <main>
      <h1>Memory</h1>
      <p>
        The agent&apos;s memory is deliberately boring: three named, bounded
        stores, every read and write traced (<code>memory.read</code> /{" "}
        <code>memory.write</code> events), no vector database. What you see here
        is everything the agent remembers.
      </p>

      <section aria-labelledby="run-state-h">
        <h2 id="run-state-h">Run state</h2>
        <p>
          Workflow state machine per run: this is what the approval gate mutates
          and what makes a paused run resumable.
        </p>
        {runStates.length === 0 ? (
          <div className="empty">
            <p>
              No run state yet. <Link href="/">Launch a run</Link> and each step
              of its state machine lands here.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Step</th>
                <th scope="col">Mode</th>
                <th scope="col">Document</th>
                <th scope="col">Revisions</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {runStates.map((record) => (
                <tr key={record.run_id}>
                  <td>
                    <Link href={`/runs/${record.run_id}`}>
                      <code>{record.run_id.slice(-8)}</code>
                    </Link>
                  </td>
                  <td>
                    <span className={`outcome-${record.step}`}>
                      {record.step}
                    </span>
                  </td>
                  <td>{record.mode}</td>
                  <td>{record.input_ref}</td>
                  <td>{record.revision_count}</td>
                  <td>{record.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="profiles-h">
        <h2 id="profiles-h">Vendor profiles</h2>
        <p>
          Bounded per-vendor memory, written only through the audited{" "}
          <code>update_vendor_profile</code> tool call. Run the same vendor
          twice and the second run reads this profile at match time.
        </p>
        {profiles.length === 0 ? (
          <div className="empty">
            <p>
              No profiles yet. The first completed run for a vendor creates its
              profile; the nightly reset clears them.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Canonical name</th>
                <th scope="col">Last seen</th>
                <th scope="col">Runs</th>
                <th scope="col">Exceptions</th>
                <th scope="col">Learned GL code</th>
                <th scope="col">Schema</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.vendor_id}>
                  <td>
                    <code>{profile.vendor_id}</code>
                  </td>
                  <td>{profile.canonical_name || "-"}</td>
                  <td>{profile.last_seen || "-"}</td>
                  <td>{profile.runs_count}</td>
                  <td>{profile.exception_count}</td>
                  <td>{profile.learned_gl_code ?? "(vendor default)"}</td>
                  <td>v{profile.profile_version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="dedupe-h">
        <h2 id="dedupe-h">Dedupe ledger</h2>
        <p>
          Normalized-content digest of every processed document, pointing at the
          run that processed it. A resubmission is held citing the prior run
          instead of being paid twice.
        </p>
        {dedupe.length === 0 ? (
          <div className="empty">
            <p>No documents processed yet.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Content digest</th>
                <th scope="col">Document</th>
                <th scope="col">First processed by</th>
              </tr>
            </thead>
            <tbody>
              {dedupe.map((row) => (
                <tr key={row.digest}>
                  <td>
                    <code>{row.digest}</code>
                  </td>
                  <td>{row.fixture}</td>
                  <td>
                    <Link href={`/runs/${row.run_id}`}>
                      <code>{row.run_id.slice(-8)}</code>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
