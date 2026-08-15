import {
  DAILY_BUDGET_MICRO_USD,
  INTAKE_NOTE_MAX_CHARS,
  IP_LIMIT_PER_DAY,
  IP_LIMIT_PER_HOUR,
  MAX_ITERATIONS,
  MAX_RUN_COST_MICRO_USD,
  RUN_WALL_CLOCK_MS,
  SESSION_RUN_CAP,
  isCapacityMode,
} from "@novagait/agent";
import { ensureSeeded, getBackend, getStore } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  capacity:
    "The demo hit its daily budget breaker and intake is paused until the nightly reset. Everything below stays browsable.",
  invalid: "Pick a document and a mode, then submit again.",
  note_too_long: `The note is capped at ${INTAKE_NOTE_MAX_CHARS} characters.`,
  rate: `Rate limit reached for your address (${IP_LIMIT_PER_HOUR} runs/hour, ${IP_LIMIT_PER_DAY}/day). The viewer and tables stay open.`,
  session: `Session cap reached (${SESSION_RUN_CAP} runs per visit). Browse the runs you made, or come back after the nightly reset.`,
  unavailable: "The live-model lane is not enabled; runs are paused.",
  run_failed: "That run failed to start. Pick a seeded document and try again.",
};

const MODE_HELP: Array<{ value: string; label: string; help: string }> = [
  {
    value: "shadow",
    label: "Shadow",
    help: "Runs end to end, execution simulated: nothing lands in the ERP.",
  },
  {
    value: "assisted",
    label: "Assisted (you approve)",
    help: "Pauses at the approval gate; you review the drafted action.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    help: "Executes without approval, but only when the server-side policy allows it.",
  },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; approver?: string }>;
}) {
  await ensureSeeded();
  const [{ error, approver }, capacity, inbox] = await Promise.all([
    searchParams,
    isCapacityMode(getStore()),
    getBackend().listInbox(),
  ]);
  const errorText = error ? ERRORS[error] : null;
  // ?approver=script (spec 10 §3): deterministic approver for e2e and the
  // walkthrough video; rides the form as a hidden field.
  const scripted = approver === "script";

  return (
    <main>
      <h1>Novagait Back Office</h1>
      <p>
        AP invoice intake with 3-way match. This demonstration ships with a full
        audit trail, deliberate memory, guardrails, and human approval gates. It
        is complete as a demonstration, and deliberately incomplete as a
        production system. The approval gate is code, not a prompt. The
        execution tool itself checks the mode and the approval state. A prompt
        cannot talk it into skipping that check.
      </p>
      <p>
        Every run is capped in code at {MAX_ITERATIONS} tool iterations,{" "}
        {RUN_WALL_CLOCK_MS / 1000} seconds, and $
        {(MAX_RUN_COST_MICRO_USD / 1_000_000).toFixed(2)} per run. The whole
        demo is capped at ${(DAILY_BUDGET_MICRO_USD / 1_000_000).toFixed(2)} per
        day.
      </p>

      {errorText ? (
        <p role="status" className="banner">
          {errorText}
        </p>
      ) : null}

      {capacity ? (
        <section aria-labelledby="capacity-h" className="empty">
          <h2 id="capacity-h">Intake paused: daily budget reached</h2>
          <p>
            The demo spent its daily budget and new runs are paused until the
            nightly reset. That is the containment story working as designed.
            The run viewer, memory tables, and mock ERP stay fully browsable.
          </p>
        </section>
      ) : (
        <section aria-labelledby="intake-h">
          <h2 id="intake-h">Process a document</h2>
          <p>
            Pick a seeded inbound document, choose a mode, and launch. Uploads
            are deliberately out of scope, because the picker is the containment
            boundary. Re-submitting an already-processed document demonstrates
            the duplicate hold.
          </p>
          <form method="post" action="/api/intake">
            {scripted ? (
              <input type="hidden" name="approver" value="script" />
            ) : null}
            <fieldset>
              <legend>Inbound document</legend>
              {inbox.map((item, index) => (
                <p key={item.id}>
                  <label>
                    <input
                      type="radio"
                      name="item"
                      value={item.id}
                      required
                      defaultChecked={index === 0}
                    />{" "}
                    {item.fixture.replace("inbox/", "")}{" "}
                    <span className="muted">
                      (received {item.received_at.slice(0, 10)}, {item.state})
                    </span>
                  </label>
                </p>
              ))}
            </fieldset>
            <fieldset>
              <legend>Mode</legend>
              {MODE_HELP.map((mode) => (
                <p key={mode.value}>
                  <label>
                    <input
                      type="radio"
                      name="mode"
                      value={mode.value}
                      required
                      defaultChecked={mode.value === "assisted"}
                    />{" "}
                    {mode.label} <span className="muted">{mode.help}</span>
                  </label>
                </p>
              ))}
            </fieldset>
            <p>
              <label htmlFor="note">
                Note to accounts payable (optional, screened like any other
                untrusted input)
              </label>
              <br />
              <input
                id="note"
                name="note"
                type="text"
                maxLength={INTAKE_NOTE_MAX_CHARS}
                size={60}
                placeholder="e.g. This one looked urgent"
              />
            </p>
            <p>
              <button type="submit">Run the agent</button>
            </p>
          </form>
        </section>
      )}
    </main>
  );
}
