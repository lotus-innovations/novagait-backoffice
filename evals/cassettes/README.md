# Replay cassettes (LOT-106, spec 09 §4)

One cassette per golden case: the normalized `RunOutcome` the graders consume,
plus provenance. `evals/runner/src/cassettes/` owns the recorder, the replay
comparator, and their tests.

```bash
npm run -w @novagait/evals-runner cassettes:record    # rewrite these files
npm run -w @novagait/evals-runner cassettes:check     # re-record to a temp dir, diff vs committed
npm run -w @novagait/evals-runner cassettes:replay    # grade + compare to evals/baseline/replay.json
npm run -w @novagait/evals-runner cassettes:baseline  # rewrite evals/baseline/replay.json
```

The recorder drives the **mock pipeline** (`packages/pipeline/src/mock-agent.ts`)
in `autonomous` mode: real executors, guardrails, state machine, approval gate
and trace writer, no model, no key, no network. `.github/workflows/eval-replay.yml`
runs `cassettes:check` then `cassettes:replay` as a blocking, key-free job.

## Recording order and state

**Fresh state per case**, with one explicit predecessor.

Each case gets its own `InMemoryStore` + freshly seeded `MockBackend`, and its
fixture is enqueued into the inbox index directly (`MockBackend` exposes no
enqueue API, and eval fixtures are fixture-map-only per `evals/CASE-PLAN.md`).

The single exception is **INV-010**, whose `GR-DUP` hold depends on a prior
run: `backend.invoiceExists()` matches vendor + invoice number in the ERP
ledger, and `CB-2026-0803` only lands there when INV-001 auto-approves and
executes. So INV-010 is recorded after replaying INV-001 through the same
store (`PRE_SEED_RUNS` in `record.ts`). Every other duplicate case (057-060)
hits a seeded `LEDGER_HISTORY` row and needs no predecessor.

Why not one shared store in ID order? Because 73 sequential runs against one
ERP accumulate ledger rows, vendor profiles and dedupe digests, so any later
case could change behaviour through state no one declared, and `CASE-PLAN`
deviation 8 explicitly assumes eval runs start from fresh ERP state. The
fresh-per-case rule makes the one real dependency visible in code instead of
hiding it in an ordering convention.

`autonomous` mode is required, not incidental: an auto-approve case must reach
the ledger for INV-010's duplicate to exist at all.

## Determinism

Re-recording must produce byte-identical files; `cassette.test.ts` records
twice into two scratch directories and compares every byte, and CI re-records
on every push.

Normalized at the cassette boundary:

| Field                   | Treatment                                                               |
| ----------------------- | ----------------------------------------------------------------------- |
| `outcome.run_id`        | ULID replaced with `RUN-<case_id>`                                      |
| `outcome.case_id`       | forced to the golden case id                                            |
| `fields.invoice_number` | mock-parser sentinel `"UNKNOWN"` -> `null`                              |
| `fields.total_cents`    | mock-parser sentinel `0` (nothing parsed) -> `null`                     |
| all object keys         | sorted at every depth, so bytes depend on values, never insertion order |

The two parser sentinels mirror `packages/pipeline/src/golden-consistency.test.ts`,
which maps the same two values; the golden dataset expresses both as `null`.

Excluded by construction (they live in the trace or the backend, never in a
`RunOutcome`, so no cassette can carry them): event timestamps and sequence
numbers, tool `duration_ms`, token counts and `total_cost_micro_usd`,
disposition ids and `created_at`, payment `pay_date`, vendor-profile
`last_seen`, approval ids, and the inbox `received_at` the recorder supplies
as a constant.

Comparison in `cassettes:check` is on the canonical serialization rather than
raw bytes: repo-wide prettier owns on-disk formatting, so a reformat is not
drift while a changed value still is.

## Expected failures

The replay lane is **expected to fail 28 of 73 cases**: the deterministic
pipeline cannot reproduce judgments that belong to the model path. Eight are
`evals/CASE-PLAN.md` deviation 7; the other twenty are structural divergences
found while recording (see `evals/baseline/replay.json` ->
`known_failing.undocumented`). `baseline.test.ts` fails if the real failing
set stops matching the declared one in either direction, so a fix or a
regression both show up as a test failure, not as a quietly moved number.
